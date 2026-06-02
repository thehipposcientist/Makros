import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, ImageBackground, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, useWindowDimensions, View, type ImageSourcePropType, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getCachedHealthInsights,
  getHealthInsights,
  recordTelemetryEvent,
} from '../services/api';
import type { HealthInsightsResponse, InsightCard, InsightConfidence, InsightDataCoverageItem } from '../types/insights';
import type { AppThemeName } from '../constants/theme';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import { isFeatureEnabled } from '../utils/featureFlags';
import BottomSheetDismissHandle from '../components/BottomSheetDismissHandle';
import ScrollRevealView, { useScrollReveal } from '../components/ScrollRevealView';
import { pexelsPhoto } from '../constants/stockImages';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

interface HealthInsightsScreenProps {
  authToken: string;
  themeName?: AppThemeName;
  days?: number;
  embedded?: boolean;
  showHeader?: boolean;
  onClose?: () => void;
}

interface InsightPreviewModuleProps {
  authToken: string;
  themeName?: AppThemeName;
  days?: number;
  onOpenAll?: () => void;
}

const HIDDEN_HEALTH_INSIGHT_IDS_KEY = 'thallo.hiddenHealthInsightIds.v1';
const INSIGHT_WARNING_YELLOW = '#F59E0B';
const INSIGHT_WARNING_RED = '#EF4444';
const INSIGHT_CARD_GRID_GAP = 10;
const INSIGHT_CARD_MIN_GRID_WIDTH = 158;
const INSIGHT_CARD_MAX_GRID_COLUMNS = 3;
const HEALTH_INSIGHTS_HERO_IMAGE = pexelsPhoto('31587561');
const HEALTH_INSIGHT_CARD_PHOTO_IDS: Record<string, string> = {
  cardiometabolic_risk_signals: '4047146',
  blood_pressure_sodium_risk_signal: '8600447',
  glp1_muscle_preservation_signal: '34742000',
  healthspan_foundations: '31775534',
  bone_density_support: '29826923',
  muscle_preservation_watch: '14074758',
  red_processed_meat_pattern: '25004924',
  blood_sugar_support_pattern: '29269763',
  cholesterol_support_pattern: '6708438',
  hormone_support: '7593020',
  hydration_electrolyte_risk: '16373067',
  kidney_stone_risk_factors: '8537879',
  energy_availability: '4929690',
  recovery_modality_response: '7901501',
  lifestyle_context: '8374450',
  digestion_patterns: '9219096',
  gut_microbiome_support: '16077408',
  inflammation_support: '8841087',
  alcohol_pattern: '3186254',
  circadian_nutrition_pattern: '5791474',
  brain_health_support: '26756092',
  protein_quality_pattern: '28870971',
  heart_health_habits: '3845129',
  menstrual_cycle_recovery_pattern: '5207369',
  cardio_efficiency_trend: '28128265',
  recovery_strain: '9004772',
  sleep_regularity_late_intake: '6756093',
  sleep_disruptors: '7641345',
  performance_readiness: '8555348',
};
const HEALTH_INSIGHT_FALLBACK_PHOTO_IDS = [
  '7052347',
  '8035822',
  '12911252',
  '6740570',
  '28576407',
  '6922158',
  '10445929',
  '3117792',
];
const RETIRED_HEALTH_INSIGHT_IDS = new Set([
  'cardio_efficiency_trend',
  'recovery_strain',
  'sleep_regularity_late_intake',
  'sleep_disruptors',
  'performance_readiness',
]);

function parseHiddenInsightIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(item => String(item || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function useHiddenHealthInsightIds() {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    let cancelled = false;
    AsyncStorage.getItem(HIDDEN_HEALTH_INSIGHT_IDS_KEY)
      .then(raw => {
        if (!cancelled) setHiddenIds(parseHiddenInsightIds(raw));
      })
      .catch(() => {
        if (!cancelled) setHiddenIds(new Set());
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);
  useFocusEffect(load);

  const setInsightVisible = useCallback((id: string, visible: boolean) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      AsyncStorage.setItem(HIDDEN_HEALTH_INSIGHT_IDS_KEY, JSON.stringify(Array.from(next))).catch(() => undefined);
      return next;
    });
  }, []);

  const showAllInsights = useCallback(() => {
    setHiddenIds(new Set());
    AsyncStorage.removeItem(HIDDEN_HEALTH_INSIGHT_IDS_KEY).catch(() => undefined);
  }, []);

  return { hiddenIds, setInsightVisible, showAllInsights };
}

function publishableHealthInsightCards(cards: InsightCard[]): InsightCard[] {
  return cards.filter(card => !RETIRED_HEALTH_INSIGHT_IDS.has(card.id));
}

function visibleHealthInsightCards(cards: InsightCard[], hiddenIds: Set<string>): InsightCard[] {
  const publishableCards = publishableHealthInsightCards(cards);
  if (hiddenIds.size === 0) return publishableCards;
  return publishableCards.filter(card => !hiddenIds.has(card.id));
}

function useHealthInsights(authToken: string, days = 14, includeUnknown = false, riskSignals = true) {
  const [data, setData] = useState<HealthInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<HealthInsightsResponse | null>(null);
  const requestKeyRef = useRef('');
  const requestKey = `${authToken}:${days}:${includeUnknown ? '1' : '0'}:${riskSignals ? '1' : '0'}`;

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const load = useCallback(() => {
    let cancelled = false;
    const requestChanged = requestKeyRef.current !== requestKey;
    if (requestChanged) {
      requestKeyRef.current = requestKey;
      dataRef.current = null;
      setData(null);
    }
    const hasVisibleData = !requestChanged && dataRef.current != null;
    if (!hasVisibleData) setLoading(true);
    setError(null);
    if (!hasVisibleData) {
      getCachedHealthInsights(authToken, days, { includeUnknown, riskSignals })
        .then(cached => {
          if (cancelled || !cached) return;
          dataRef.current = cached;
          setData(cached);
          setError(null);
          setLoading(false);
        })
        .catch(() => undefined);
    }
    getHealthInsights(authToken, days, { includeUnknown, riskSignals, preferFresh: true })
      .then(result => {
        if (cancelled) return;
        dataRef.current = result;
        setData(result);
        setError(null);
      })
      .catch(err => {
        if (!cancelled) {
          if (!dataRef.current) {
            setError(String(err?.message ?? 'Unable to load insights'));
            setData(null);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [authToken, days, includeUnknown, requestKey, riskSignals]);

  useEffect(() => load(), [load]);
  // Refresh when the parent screen regains focus so navigating back to
  // Progress (or any host) doesn't leave a stale snapshot on screen.
  // First focus is skipped — the mount-time `useEffect(load)` above
  // already covers that and we don't want a duplicate request.
  const skipFirstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (skipFirstFocusRef.current) {
        skipFirstFocusRef.current = false;
        return;
      }
      load();
    }, [load]),
  );
  return { data, loading, error, refresh: load };
}

type InsightDisplayBand = 'good' | 'ok' | 'watch' | 'high_watch' | 'needs_data';

function clampInsightScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function insightSupportScore(card: InsightCard): number {
  const raw = clampInsightScore(card.score);
  return card.risk_direction === 'higher_is_worse' ? 100 - raw : raw;
}

function insightDisplayBand(card: InsightCard): InsightDisplayBand {
  if (card.status === 'unknown') return 'needs_data';
  if (card.status === 'watch') return 'watch';
  const support = insightSupportScore(card);
  if (support >= 75) return 'good';
  if (support >= 60) return 'ok';
  if (support >= 40) return 'watch';
  return 'high_watch';
}

function insightNeedsAttention(card: InsightCard): boolean {
  const band = insightDisplayBand(card);
  return band === 'watch' || band === 'high_watch';
}

function insightDisplayTone(card: InsightCard, colors: ThemeColors) {
  switch (insightDisplayBand(card)) {
    case 'good':
      return { bg: '#22C55E22', border: '#22C55E66', text: '#22C55E' };
    case 'ok':
      return { bg: colors.primary + '1F', border: colors.primary + '55', text: colors.primary };
    case 'watch':
      return { bg: '#F59E0B22', border: '#F59E0B66', text: '#F59E0B' };
    case 'high_watch':
      return { bg: '#EF444422', border: '#EF444466', text: '#EF4444' };
    default:
      return { bg: colors.surfaceRaised, border: colors.border, text: colors.textMuted };
  }
}

function insightCardColumnCount(width: number): number {
  if (width <= 0) return 1;
  const fitCount = Math.floor((width + INSIGHT_CARD_GRID_GAP) / (INSIGHT_CARD_MIN_GRID_WIDTH + INSIGHT_CARD_GRID_GAP));
  return Math.max(1, Math.min(INSIGHT_CARD_MAX_GRID_COLUMNS, fitCount));
}

function statusMeaning(card: InsightCard) {
  switch (insightDisplayBand(card)) {
    case 'needs_data':
      return {
        label: 'Needs data',
        detail: 'Recent logs are too sparse to read this pattern confidently.',
      };
    case 'good':
      return {
        label: 'Good',
        detail: 'Recent logs look supportive for this area.',
      };
    case 'ok':
      return {
        label: 'OK',
        detail: 'The pattern is mostly supportive, with room to improve.',
      };
    case 'watch':
      return {
        label: 'Watch',
        detail: 'A support gap is showing up in recent logs.',
      };
    case 'high_watch':
      return {
        label: 'High watch',
        detail: 'This is one of the stronger support gaps to watch.',
      };
  }
}

function primaryWhyLine(card: InsightCard) {
  if (card.drivers.length > 0) return card.drivers[0];
  if (card.positive_factors.length > 0) return card.positive_factors[0];
  if (card.missing_data.length > 0) {
    const missing = card.missing_data.slice(0, 2).join(' and ');
    return `This insight has limited confidence because ${missing} data is missing.`;
  }
  return 'Enough recent logs are available for this wellness pattern to be shown.';
}

function primaryActionLine(card: InsightCard): string {
  if (card.recommendations.length > 0) return card.recommendations[0];
  if (card.drivers.length > 0) return card.drivers[0];
  if (card.positive_factors.length > 0) return card.positive_factors[0];
  if (card.missing_data.length > 0) return `Add ${card.missing_data.slice(0, 2).join(' and ')} data to sharpen this read.`;
  return 'Keep logging consistently so this pattern stays current.';
}

function conciseActionLine(card: InsightCard): string {
  return primaryActionLine(card).replace(/\s+/g, ' ').replace(/\.$/, '');
}

function insightCategoryLabel(category: string): string {
  const key = category.toLowerCase();
  if (key.includes('health_risk')) return 'Health Risk Signals';
  if (key.includes('brain')) return 'Brain Health';
  if (key.includes('healthspan')) return 'Healthspan';
  if (key.includes('cardio')) return 'Cardio';
  if (key.includes('diet_quality') || key.includes('diet')) return 'Diet';
  if (key.includes('metabolic') || key.includes('blood_sugar') || key.includes('glucose')) return 'Metabolic';
  if (key.includes('cholesterol') || key.includes('lipid')) return 'Cholesterol';
  if (key.includes('sleep')) return 'Sleep';
  if (key.includes('nutrition')) return 'Fuel';
  if (key.includes('gut') || key.includes('digestion') || key.includes('microbiome')) return 'Gut';
  if (key.includes('hydration')) return 'Hydration';
  if (key.includes('inflammation')) return 'Inflammation';
  if (key.includes('alcohol')) return 'Lifestyle';
  if (key.includes('circadian')) return 'Timing';
  if (key.includes('training') || key.includes('activity') || key.includes('workout') || key.includes('injury')) return 'Training';
  if (key.includes('recovery') || key.includes('readiness')) return 'Recovery';
  if (key.includes('heart')) return 'Heart';
  if (key.includes('body') || key.includes('weight')) return 'Body';
  return 'Wellness';
}

function insightFilterKey(card: InsightCard): string {
  if (card.status === 'unknown') return 'needs_data';
  return insightCategoryLabel(card.category).toLowerCase().replace(/\s+/g, '_');
}

function filterLabel(key: string): string {
  if (key === 'all') return 'All';
  if (key === 'watch') return 'Watch';
  if (key === 'needs_data') return 'Needs data';
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function scoreExplanation(meaning: ReturnType<typeof statusMeaning>) {
  return `Higher means your recent habits support this area more strongly. ${meaning.detail}`;
}

function notDoneTone(card: InsightCard): string {
  const band = insightDisplayBand(card);
  if (band === 'high_watch' || card.status === 'high' || card.status === 'elevated') {
    return INSIGHT_WARNING_RED;
  }
  return INSIGHT_WARNING_YELLOW;
}

function confidenceLabel(confidence: InsightConfidence) {
  return `${confidence[0].toUpperCase()}${confidence.slice(1)} confidence`;
}

function cardPriority(card: InsightCard): number {
  const status = { high: 50, elevated: 40, watch: 34, moderate: 25, low: 10, unknown: 0 }[card.status] ?? 0;
  const confidence = { high: 12, medium: 8, low: 2 }[card.confidence] ?? 0;
  const riskMagnitude = 100 - insightSupportScore(card);
  return status + confidence + riskMagnitude / 100;
}

function selectPreviewCards(cards: InsightCard[]): InsightCard[] {
  const fallback = [...cards].sort((a, b) => cardPriority(b) - cardPriority(a));
  const preferred = fallback.filter(card => insightNeedsAttention(card) && ['medium', 'high'].includes(card.confidence));
  const seen = new Set<string>();
  const ordered = [...preferred, ...fallback].filter(card => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
  return ordered.slice(0, 4);
}

function insightScoreColor(card: InsightCard, colors: ThemeColors) {
  if (card.status === 'unknown') return colors.textMuted;
  const support = insightSupportScore(card);
  if (support >= 75) return '#22C55E';
  if (support >= 60) return colors.primary;
  if (support >= 40) return '#F59E0B';
  return '#EF4444';
}

function supportScoreDisplay(card: InsightCard): string {
  return card.status === 'unknown' ? '--' : String(insightSupportScore(card));
}

function supportScoreAccessibility(card: InsightCard): string {
  return card.status === 'unknown'
    ? 'Habit support needs more data'
    : `Habit support score ${insightSupportScore(card)} of 100`;
}

function categoryIcon(category: string): React.ComponentProps<typeof Ionicons>['name'] {
  const key = category.toLowerCase();
  if (key.includes('health_risk')) return 'warning-outline';
  if (key.includes('brain')) return 'bulb-outline';
  if (key.includes('healthspan')) return 'fitness-outline';
  if (key.includes('cardio')) return 'pulse-outline';
  if (key.includes('diet_quality') || key.includes('diet')) return 'restaurant-outline';
  if (key.includes('metabolic') || key.includes('blood_sugar') || key.includes('glucose')) return 'analytics-outline';
  if (key.includes('cholesterol') || key.includes('lipid')) return 'heart-outline';
  if (key.includes('sleep')) return 'moon-outline';
  if (key.includes('nutrition') || key.includes('gut') || key.includes('microbiome')) return 'nutrition-outline';
  if (key.includes('activity') || key.includes('training') || key.includes('workout')) return 'barbell-outline';
  if (key.includes('hydration')) return 'water-outline';
  if (key.includes('inflammation')) return 'leaf-outline';
  if (key.includes('alcohol')) return 'wine-outline';
  if (key.includes('circadian')) return 'time-outline';
  if (key.includes('recovery') || key.includes('readiness')) return 'pulse-outline';
  if (key.includes('body') || key.includes('weight')) return 'body-outline';
  return 'sparkles-outline';
}

function categoryTint(category: string, colors: ThemeColors) {
  const key = category.toLowerCase();
  if (key.includes('health_risk')) return '#F59E0B';
  if (key.includes('brain')) return '#6366F1';
  if (key.includes('healthspan')) return '#10B981';
  if (key.includes('cardio')) return '#06B6D4';
  if (key.includes('diet_quality') || key.includes('diet')) return '#F97316';
  if (key.includes('metabolic') || key.includes('blood_sugar') || key.includes('glucose')) return '#14B8A6';
  if (key.includes('cholesterol') || key.includes('lipid')) return '#EF4444';
  if (key.includes('hydration')) return '#38BDF8';
  if (key.includes('inflammation')) return '#16A34A';
  if (key.includes('sleep')) return '#8B5CF6';
  if (key.includes('recovery') || key.includes('readiness')) return '#22C55E';
  if (key.includes('heart')) return '#F43F5E';
  if (key.includes('digestion') || key.includes('gut') || key.includes('microbiome') || key.includes('nutrition')) return '#84CC16';
  if (key.includes('alcohol')) return '#F97316';
  if (key.includes('circadian')) return '#06B6D4';
  return colors.primary;
}

function pexelsImageSource(id: string): ImageSourcePropType {
  return { uri: pexelsPhoto(id, { width: 420, height: 420 }) };
}

function stableHealthInsightPhotoId(card: InsightCard): string {
  let hash = 0;
  const key = `${card.id}:${card.category}`;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return HEALTH_INSIGHT_FALLBACK_PHOTO_IDS[Math.abs(hash) % HEALTH_INSIGHT_FALLBACK_PHOTO_IDS.length];
}

function insightImageSource(card: InsightCard): ImageSourcePropType {
  return pexelsImageSource(HEALTH_INSIGHT_CARD_PHOTO_IDS[card.id] ?? stableHealthInsightPhotoId(card));
}

const COVERAGE_ORDER = [
  'nutrition',
  'sleep',
  'activity',
  'workouts',
  'apple_health',
  'hydration',
  'lifestyle',
  'micronutrients',
  'labs',
  'cycle',
  'recovery_modalities',
];

type CoverageRow = { key: string; item: InsightDataCoverageItem };
type FilterOption = { key: string; label: string; count: number };
type HealthReadConfidence = {
  label: string;
  detail: string;
  tone: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
};

function qualityLabel(value: string | null | undefined): string {
  const key = String(value ?? '').toLowerCase();
  if (key === 'not_opted_in') return 'Not opted in';
  if (key === 'missing') return 'Missing';
  if (key === 'high') return 'Strong';
  if (key === 'medium') return 'Partial';
  if (key === 'low') return 'Sparse';
  if (!key) return 'Unknown';
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function qualityTone(value: string | null | undefined, colors: ThemeColors): string {
  const key = String(value ?? '').toLowerCase();
  if (key === 'high') return '#22C55E';
  if (key === 'medium') return colors.primary;
  if (key === 'low') return '#F59E0B';
  if (key === 'missing' || key === 'not_opted_in') return colors.textMuted;
  return colors.primary;
}

function coverageRows(data: HealthInsightsResponse | null | undefined): CoverageRow[] {
  const coverage = data?.data_coverage;
  if (!coverage) return [];
  const keys = Object.keys(coverage);
  const orderedKeys = [
    ...COVERAGE_ORDER.filter(key => keys.includes(key)),
    ...keys.filter(key => !COVERAGE_ORDER.includes(key)).sort(),
  ];
  return orderedKeys.map(key => ({ key, item: coverage[key] })).filter(row => Boolean(row.item));
}

function confidenceScore(value: string | null | undefined): number | null {
  const key = String(value ?? '').toLowerCase();
  if (key === 'high') return 3;
  if (key === 'medium') return 2;
  if (key === 'low') return 1;
  if (key === 'missing') return 0;
  return null;
}

function healthReadConfidence(data: HealthInsightsResponse | null | undefined, rows: CoverageRow[], colors: ThemeColors): HealthReadConfidence {
  const coverageScores = rows
    .map(row => confidenceScore(row.item.quality))
    .filter((score): score is number => score != null);
  const qualityScores = Object.values((data?.data_quality ?? {}) as Record<string, string | undefined>)
    .map(confidenceScore)
    .filter((score): score is number => score != null);
  const scores = coverageScores.length > 0 ? coverageScores : qualityScores;
  if (scores.length === 0) {
    return {
      label: 'Needs data',
      detail: 'Coverage details will appear as recent logs sync.',
      tone: colors.textMuted,
      icon: 'help-circle-outline',
    };
  }
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  if (average >= 2.5) {
    return {
      label: 'High confidence',
      detail: 'Tap to see what shaped this read.',
      tone: '#22C55E',
      icon: 'shield-checkmark-outline',
    };
  }
  if (average >= 1.6) {
    return {
      label: 'Medium confidence',
      detail: 'Some sources are partial. Tap to see why.',
      tone: colors.primary,
      icon: 'shield-outline',
    };
  }
  if (average >= 0.7) {
    return {
      label: 'Low confidence',
      detail: 'Sparse recent logs. Tap to see what would sharpen it.',
      tone: '#F59E0B',
      icon: 'alert-circle-outline',
    };
  }
  return {
    label: 'Needs data',
    detail: 'Tap to see which logs would help.',
    tone: colors.textMuted,
    icon: 'add-circle-outline',
  };
}

function coverageDisplay(row: CoverageRow): string {
  const item = row.item;
  if (item.display) return item.display;
  if (item.days_with_data != null && item.window_days != null) {
    return `${item.days_with_data} of ${item.window_days} ${item.unit || 'days'}`;
  }
  if (item.records != null) {
    return `${item.records} ${item.unit || 'records'}`;
  }
  return qualityLabel(item.quality);
}

function sourceLabel(key: string, item?: InsightDataCoverageItem): string {
  if (item?.label) return item.label;
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function generatedAtLabel(value: string | null | undefined): string {
  if (!value) return 'Updated recently';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Updated recently';
  return `Updated ${parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function countForFilter(key: string, cards: InsightCard[], defaultCards: InsightCard[]): number {
  if (key === 'all') return defaultCards.length;
  if (key === 'watch') return cards.filter(insightNeedsAttention).length;
  return cards.filter(card => insightFilterKey(card) === key).length;
}

function buildFilterOptions(cards: InsightCard[], defaultCards: InsightCard[]): FilterOption[] {
  const keys = new Set<string>();
  cards.forEach(card => keys.add(insightFilterKey(card)));
  const ordered = ['all'];
  if (cards.some(insightNeedsAttention)) ordered.push('watch');
  ['health_risk_signals', 'brain_health', 'diet', 'metabolic', 'cholesterol', 'recovery', 'sleep', 'fuel', 'training', 'hydration', 'gut', 'lifestyle', 'timing', 'inflammation', 'heart', 'body', 'wellness', 'needs_data']
    .forEach(key => { if (keys.has(key)) ordered.push(key); });
  return ordered
    .map(key => ({ key, label: filterLabel(key), count: countForFilter(key, cards, defaultCards) }))
    .filter(option => option.count > 0 || option.key === 'all');
}

function firstMissingDataLine(cards: InsightCard[]): string {
  const missing = cards.flatMap(card => card.missing_data).map(readableDataLabel);
  const unique = Array.from(new Set(missing)).slice(0, 2);
  if (unique.length === 0) return 'A few more consistent logs will unlock sharper reads.';
  return `Add ${readableList(unique).toLowerCase()} to unlock sharper reads.`;
}

function isRiskSignalCard(card: InsightCard): boolean {
  return card.category.toLowerCase() === 'health_risk_signals';
}

function insightTelemetryPayload(card: InsightCard, surface: string, extra: Record<string, any> = {}) {
  return {
    card_id: card.id,
    title: card.title,
    category: card.category,
    status: card.status,
    confidence: card.confidence,
    surface,
    ...extra,
  };
}

function useCardShownTelemetry(authToken: string, cards: InsightCard[], surface: string) {
  const shownRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    cards.forEach(card => {
      const key = `${surface}:${card.id}`;
      if (shownRef.current.has(key)) return;
      shownRef.current.add(key);
      recordTelemetryEvent('health_insight_card_shown', insightTelemetryPayload(card, surface), authToken);
    });
  }, [authToken, cards, surface]);
}

function InsightListRow({
  card,
  colors,
  compact = false,
  isLast = false,
  onPress,
}: {
  card: InsightCard;
  colors: ThemeColors;
  compact?: boolean;
  isLast?: boolean;
  onPress: () => void;
}) {
  const tone = insightDisplayTone(card, colors);
  const meaning = statusMeaning(card);
  const scoreColor = insightScoreColor(card, colors);
  const supportDisplay = supportScoreDisplay(card);
  const action = conciseActionLine(card);
  const category = insightCategoryLabel(card.category);
  const visualColor = categoryTint(card.category, colors);
  const imageSource = insightImageSource(card);
  return (
    <TouchableOpacity
      activeOpacity={0.78}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. ${meaning.label}. Open insight details.`}
      onPress={onPress}
      style={[
        styles.insightRow,
        compact && styles.compactInsightRow,
        !isLast && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}>
      <View style={[styles.rowAccent, { backgroundColor: visualColor }]} />
      <ImageBackground source={imageSource} resizeMode="cover" imageStyle={styles.rowImage} style={[styles.rowImageWrap, { borderColor: visualColor + '55' }]}>
        <LinearGradient colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.58)']} style={StyleSheet.absoluteFill} />
        <View style={[styles.rowImageIcon, { backgroundColor: visualColor + 'CC' }]}>
          <Ionicons name={categoryIcon(card.category)} size={13} color="#FFFFFF" />
        </View>
      </ImageBackground>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowMeta, { color: tone.text }]} numberOfLines={1}>
          {category} · {meaning.label}
        </Text>
        <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {card.title}
        </Text>
        <Text style={[styles.rowMetric, { color: colors.textSecondary }]} numberOfLines={1}>
          Habit support {supportDisplay}{card.status === 'unknown' ? '' : '/100'} · {confidenceLabel(card.confidence)}
        </Text>
        <View style={styles.rowAction}>
          <Ionicons name="arrow-forward-circle" size={13} color={colors.primary} />
          <Text style={[styles.rowActionText, { color: colors.textSecondary }]} numberOfLines={1}>
            <Text style={{ color: colors.textPrimary, fontWeight: '900' }}>Next: </Text>
            {action}
          </Text>
        </View>
      </View>
      <View style={styles.rowScoreWrap}>
        <View style={[styles.rowScoreBadge, { backgroundColor: scoreColor + '18', borderColor: scoreColor + '55' }]}>
          <Text style={[styles.rowScoreValue, { color: scoreColor }]}>{supportDisplay}</Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

function InsightSelectableCard({
  card,
  colors,
  compact = false,
  onPress,
}: {
  card: InsightCard;
  colors: ThemeColors;
  compact?: boolean;
  onPress: () => void;
}) {
  const meaning = statusMeaning(card);
  const scoreColor = insightScoreColor(card, colors);
  const supportDisplay = supportScoreDisplay(card);
  const category = insightCategoryLabel(card.category);
  const visualColor = categoryTint(card.category, colors);
  const imageSource = insightImageSource(card);
  const action = conciseActionLine(card);
  const categoryMeta = compact ? category : `${category} · ${meaning.label}`;
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. ${meaning.label}. ${supportScoreAccessibility(card)}. Open insight details.`}
      onPress={onPress}
      style={[styles.stackedInsightCard, compact && styles.compactStackedInsightCard, { backgroundColor: colors.surface, borderColor: visualColor + '55' }]}>
      <ImageBackground source={imageSource} resizeMode="cover" imageStyle={styles.stackedInsightImage} style={[styles.stackedInsightImageWrap, compact && styles.compactStackedInsightImageWrap]}>
        <LinearGradient colors={['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.34)', 'rgba(0,0,0,0.82)']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
        <View style={styles.stackedInsightTopRow}>
          <View style={[styles.stackedInsightCategoryPill, compact && styles.compactStackedInsightCategoryPill, { borderColor: visualColor + '88', backgroundColor: 'rgba(0,0,0,0.44)' }]}>
            <Ionicons name={categoryIcon(card.category)} size={14} color={visualColor} />
            <Text style={[styles.stackedInsightCategoryText, compact && styles.compactStackedInsightCategoryText]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
              {categoryMeta}
            </Text>
          </View>
          <View style={[styles.stackedInsightScore, compact && styles.compactStackedInsightScore, { backgroundColor: 'rgba(0,0,0,0.46)', borderColor: scoreColor + '99' }]}>
            <Text style={[styles.stackedInsightScoreValue, { color: scoreColor }]}>{supportDisplay}</Text>
            <Text style={styles.stackedInsightScoreLabel}>Score</Text>
          </View>
        </View>

        <View style={styles.stackedInsightBottom}>
          <Text style={[styles.stackedInsightTitle, compact && styles.compactStackedInsightTitle]} numberOfLines={compact ? 3 : 2} adjustsFontSizeToFit minimumFontScale={0.74}>
            {card.title}
          </Text>
          <View style={styles.stackedInsightActionRow}>
            <Ionicons name="arrow-forward-circle" size={15} color="#FFFFFFD9" />
            <Text style={[styles.stackedInsightActionText, compact && styles.compactStackedInsightActionText]} numberOfLines={compact ? 3 : 2}>
              <Text style={styles.stackedInsightActionLead}>Next: </Text>
              {action}
            </Text>
          </View>
          <View style={styles.stackedInsightFooterRow}>
            <Text style={styles.stackedInsightConfidence} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
              {confidenceLabel(card.confidence)}
            </Text>
            <View style={styles.stackedInsightDetails}>
              <Text style={styles.stackedInsightDetailsText}>Details</Text>
              <Ionicons name="chevron-forward" size={14} color="#FFFFFF" />
            </View>
          </View>
        </View>
      </ImageBackground>
    </TouchableOpacity>
  );
}

function HealthReadConfidenceRow({
  confidence,
  colors,
  onPress,
}: {
  confidence: HealthReadConfidence;
  colors: ThemeColors;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={`${confidence.label}. Open data sources.`}
      onPress={onPress}
      style={[styles.healthConfidenceRow, { backgroundColor: confidence.tone + '12', borderColor: confidence.tone + '44' }]}>
      <View style={[styles.healthConfidenceIcon, { backgroundColor: confidence.tone + '18' }]}>
        <Ionicons name={confidence.icon} size={16} color={confidence.tone} />
      </View>
      <View style={styles.healthConfidenceCopy}>
        <Text style={[styles.healthConfidenceLabel, { color: confidence.tone }]} numberOfLines={1}>
          {confidence.label}
        </Text>
        <Text style={[styles.healthConfidenceDetail, { color: colors.textSecondary }]} numberOfLines={1}>
          {confidence.detail}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function HealthReadOverview({
  data,
  cards,
  hiddenCount,
  colors,
  onOpenSources,
  onOpenCustomize,
}: {
  data: HealthInsightsResponse | null;
  cards: InsightCard[];
  hiddenCount: number;
  colors: ThemeColors;
  onOpenSources: () => void;
  onOpenCustomize: () => void;
}) {
  const attentionCount = cards.filter(insightNeedsAttention).length;
  const needsDataCount = cards.filter(card => card.status === 'unknown').length;
  const coverage = coverageRows(data);
  const confidence = healthReadConfidence(data, coverage, colors);
  const summary = data?.overall_summary?.trim()
    || (attentionCount > 0
      ? `${attentionCount} pattern${attentionCount === 1 ? '' : 's'} need attention in this read.`
      : 'No risky patterns stand out in the current read.');
  return (
    <View style={[styles.overviewCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ImageBackground
        source={{ uri: HEALTH_INSIGHTS_HERO_IMAGE }}
        resizeMode="cover"
        imageStyle={styles.overviewHeroImage}
        style={styles.overviewHero}>
        <LinearGradient
          colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.68)']}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          pointerEvents="none"
          colors={[colors.primary + '44', '#14B8A62A', 'rgba(0,0,0,0)']}
          locations={[0, 0.48, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.overviewHeroMeta}>
          <View style={[styles.overviewHeroIcon, { backgroundColor: '#FFFFFF24', borderColor: '#FFFFFF66' }]}>
            <Ionicons name="sparkles-outline" size={18} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.overviewHeroEyebrow} numberOfLines={1}>
              {generatedAtLabel(data?.generated_at)}
            </Text>
            <Text style={styles.overviewHeroTitle} numberOfLines={1}>
              Health read
            </Text>
            <Text style={styles.overviewHeroSummary} numberOfLines={3}>
              {summary}
            </Text>
          </View>
        </View>
      </ImageBackground>

      <View style={styles.overviewStatsRow}>
        <View style={[styles.overviewStat, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Text style={[styles.overviewStatValue, { color: attentionCount > 0 ? INSIGHT_WARNING_YELLOW : '#22C55E' }]}>
            {attentionCount}
          </Text>
          <Text style={[styles.overviewStatLabel, { color: colors.textMuted }]}>Watch</Text>
        </View>
        <View style={[styles.overviewStat, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Text style={[styles.overviewStatValue, { color: colors.textPrimary }]}>{cards.length}</Text>
          <Text style={[styles.overviewStatLabel, { color: colors.textMuted }]}>Insights</Text>
        </View>
        <View style={[styles.overviewStat, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Text style={[styles.overviewStatValue, { color: needsDataCount > 0 ? '#F59E0B' : colors.textPrimary }]}>
            {needsDataCount}
          </Text>
          <Text style={[styles.overviewStatLabel, { color: colors.textMuted }]}>Needs data</Text>
        </View>
        <View style={[styles.overviewStat, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Text style={[styles.overviewStatValue, { color: hiddenCount > 0 ? colors.primary : colors.textPrimary }]}>
            {hiddenCount}
          </Text>
          <Text style={[styles.overviewStatLabel, { color: colors.textMuted }]}>Hidden</Text>
        </View>
      </View>

      <HealthReadConfidenceRow confidence={confidence} colors={colors} onPress={onOpenSources} />

      <View style={styles.overviewActions}>
        <TouchableOpacity
          activeOpacity={0.78}
          accessibilityRole="button"
          accessibilityLabel="Customize insight cards"
          onPress={onOpenCustomize}
          style={[styles.overviewActionButton, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Ionicons name="options-outline" size={15} color={colors.textSecondary} />
          <Text style={[styles.overviewActionText, { color: colors.textPrimary }]}>Customize</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function NeedsDataPrompt({
  count,
  cards,
  colors,
  onPress,
}: {
  count: number;
  cards: InsightCard[];
  colors: ThemeColors;
  onPress: () => void;
}) {
  if (count <= 0) return null;
  return (
    <TouchableOpacity
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={`${count} insights need more data. View needs data insights.`}
      onPress={onPress}
      style={[styles.needsDataPrompt, { backgroundColor: '#F59E0B12', borderColor: '#F59E0B44' }]}>
      <View style={[styles.needsDataIcon, { backgroundColor: '#F59E0B1F' }]}>
        <Ionicons name="add-circle-outline" size={18} color="#F59E0B" />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.needsDataTitle, { color: colors.textPrimary }]}>
          {count} insight{count === 1 ? '' : 's'} need better data
        </Text>
        <Text style={[styles.needsDataBody, { color: colors.textSecondary }]} numberOfLines={2}>
          {firstMissingDataLine(cards)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function PriorityInsightCard({
  card,
  colors,
  label = 'Priority insight',
  onPress,
}: {
  card: InsightCard;
  colors: ThemeColors;
  label?: string;
  onPress: () => void;
}) {
  const meaning = statusMeaning(card);
  const tone = insightDisplayTone(card, colors);
  const scoreColor = insightScoreColor(card, colors);
  const supportDisplay = supportScoreDisplay(card);
  const category = insightCategoryLabel(card.category);
  const visualColor = categoryTint(card.category, colors);
  return (
    <TouchableOpacity
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. ${meaning.label}. ${supportScoreAccessibility(card)}. Open insight details.`}
      onPress={onPress}
      style={[styles.priorityCard, { backgroundColor: colors.surface, borderColor: visualColor + '44' }]}>
      <View style={[styles.priorityAccent, { backgroundColor: visualColor }]} />
      <View style={styles.priorityHeader}>
        <View style={[styles.priorityIcon, { backgroundColor: visualColor + '18', borderColor: visualColor + '55' }]}>
          <Ionicons name={categoryIcon(card.category)} size={18} color={visualColor} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.priorityEyebrow, { color: visualColor }]} numberOfLines={1}>
            {label} · {category}
          </Text>
          <Text style={[styles.priorityTitle, { color: colors.textPrimary }]} numberOfLines={2}>
            {card.title}
          </Text>
        </View>
        <View style={[styles.priorityScore, { backgroundColor: scoreColor + '18', borderColor: scoreColor + '66' }]}>
          <Text style={[styles.priorityScoreValue, { color: scoreColor }]}>{supportDisplay}</Text>
          <Text style={[styles.priorityScoreLabel, { color: scoreColor }]}>support</Text>
        </View>
      </View>
      <Text style={[styles.priorityWhy, { color: colors.textSecondary }]} numberOfLines={3}>
        {primaryWhyLine(card)}
      </Text>
      <View style={[styles.priorityActionBox, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
        <View style={[styles.priorityActionIcon, { backgroundColor: colors.primary + '18' }]}>
          <Ionicons name="arrow-forward-circle" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.priorityActionLabel, { color: colors.textMuted }]}>Try next</Text>
          <Text style={[styles.priorityActionText, { color: colors.textPrimary }]} numberOfLines={3}>
            {primaryActionLine(card)}
          </Text>
        </View>
      </View>
      <View style={styles.priorityMetaRow}>
        <View style={[styles.priorityMetaPill, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          <Text style={[styles.priorityMetaText, { color: tone.text }]} numberOfLines={1}>
            {meaning.label}
          </Text>
        </View>
        <View style={[styles.priorityMetaPill, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
          <Text style={[styles.priorityMetaText, { color: colors.textSecondary }]} numberOfLines={1}>
            {confidenceLabel(card.confidence)}
          </Text>
        </View>
        <View style={styles.priorityOpen}>
          <Text style={[styles.priorityOpenText, { color: colors.primary }]}>Details</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

function InsightPatternCard({
  card,
  colors,
  onPress,
}: {
  card: InsightCard;
  colors: ThemeColors;
  onPress: () => void;
}) {
  const meaning = statusMeaning(card);
  const tone = insightDisplayTone(card, colors);
  const scoreColor = insightScoreColor(card, colors);
  const supportScore = insightSupportScore(card);
  const supportDisplay = supportScoreDisplay(card);
  const supportFill = card.status === 'unknown' ? 0 : supportScore;
  const category = insightCategoryLabel(card.category);
  const visualColor = categoryTint(card.category, colors);
  const action = conciseActionLine(card);
  return (
    <TouchableOpacity
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. ${meaning.label}. ${supportScoreAccessibility(card)}. Open insight details.`}
      onPress={onPress}
      style={[styles.patternCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.patternHeader}>
        <View style={[styles.patternIcon, { backgroundColor: visualColor + '18', borderColor: visualColor + '55' }]}>
          <Ionicons name={categoryIcon(card.category)} size={17} color={visualColor} />
        </View>
        <View style={[styles.patternScoreBadge, { backgroundColor: scoreColor + '16', borderColor: scoreColor + '55' }]}>
          <Text style={[styles.patternScoreValue, { color: scoreColor }]}>{supportDisplay}</Text>
        </View>
      </View>
      <Text style={[styles.patternCategory, { color: visualColor }]} numberOfLines={1}>{category}</Text>
      <Text style={[styles.patternTitle, { color: colors.textPrimary }]} numberOfLines={2}>
        {card.title}
      </Text>
      <View style={styles.patternSignalTrack}>
        <View style={[styles.patternSignalFill, { width: `${supportFill}%`, backgroundColor: scoreColor }]} />
      </View>
      <View style={styles.patternMetaRow}>
        <View style={[styles.patternStatusPill, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          <Text style={[styles.patternStatusText, { color: tone.text }]} numberOfLines={1}>
            {meaning.label}
          </Text>
        </View>
        <Text style={[styles.patternConfidence, { color: colors.textMuted }]} numberOfLines={1}>
          {confidenceLabel(card.confidence)}
        </Text>
      </View>
      <Text style={[styles.patternAction, { color: colors.textSecondary }]} numberOfLines={2}>
        <Text style={{ color: colors.textPrimary, fontWeight: '900' }}>Next: </Text>
        {action}
      </Text>
    </TouchableOpacity>
  );
}

function InsightSectionTitle({ title, colors }: { title: string; colors: ThemeColors }) {
  return (
    <View style={styles.insightSectionHeader}>
      <Text style={[styles.insightSectionTitle, { color: colors.textPrimary }]}>{title}</Text>
    </View>
  );
}

function briefItems(items: string[], limit = 3): string[] {
  const seen = new Set<string>();
  return items
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(item => {
      if (!item || seen.has(item.toLowerCase())) return false;
      seen.add(item.toLowerCase());
      return true;
    })
    .slice(0, limit);
}

function briefSummary(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'This is a recent wellness pattern estimate from your logs.';
  const firstSentence = cleaned.match(/^[^.!?]+[.!?]/)?.[0] ?? cleaned;
  if (firstSentence.length <= 150) return firstSentence;
  return `${firstSentence.slice(0, 147).trim()}...`;
}

function readableDataLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function readableList(items: string[]): string {
  const cleaned = items.map(item => item.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`;
}

const PLAIN_LANGUAGE_CHECKS_BY_ID: Record<string, { intro: string; checks: string[] }> = {
  brain_health_support: {
    intro: 'Brain Health Support is a habit pattern, not a cognitive test: it looks at behaviors that can support focus, mental energy, and long-term brain-health basics.',
    checks: [
      'sleep duration and timing',
      'omega-3 or seafood pattern',
      'fiber and plant variety',
      'hydration',
      'daily movement and cardio',
      'caffeine and alcohol timing',
      'optional B12, folate, iron, magnesium, and vitamin D logs',
      'optional HRV and resting-heart-rate context',
    ],
  },
  cardiometabolic_risk_signals: {
    intro: 'Cardiometabolic means the overlap between heart health and metabolism: blood-sugar support, blood pressure, blood fats, body-weight trends, and daily movement.',
    checks: [
      'age and sex context',
      'height/weight or BMI',
      'weight trend',
      'active days and steps',
      'cardio minutes',
      'resistance training days',
      'added sugar and sugary drinks',
      'fiber intake',
      'sleep duration',
      'blood-pressure readings',
      'optional A1C, fasting-glucose, and cholesterol labs',
    ],
  },
  gut_microbiome_support: {
    intro: 'Gut Microbiome Support looks at what you feed your gut bacteria — not bacterial counts or stool analysis. It scores the dietary and lifestyle inputs that research most consistently associates with a diverse, resilient microbiome.',
    checks: [
      'daily fiber intake',
      'fermented food frequency (yogurt, kefir, kimchi, sauerkraut, kombucha)',
      'plant food variety across the week',
      'legume and whole grain frequency',
      'ultra-processed food share of diet',
      'omega-3 or seafood presence',
      'alcohol intake (disrupts gut balance)',
      'sleep duration (linked to microbial diversity)',
    ],
  },
  alcohol_pattern: {
    intro: 'Alcohol Pattern tracks how much and how often alcohol appears in your logs and cross-references it with sleep and recovery signals. It is a habit-pattern read, not a screening tool — consult a healthcare provider if you have concerns.',
    checks: [
      'average alcohol servings per logged day',
      'number of days alcohol was logged',
      'evening alcohol frequency',
      'sleep duration on days with alcohol logged',
      'optional HRV and resting heart rate context',
    ],
  },
  circadian_nutrition_pattern: {
    intro: 'Circadian Nutrition Timing looks at when you eat, not just what — late-night meals, post-workout fueling, and sleep timing consistency all affect how your body processes food around the clock.',
    checks: [
      'late-night meal frequency and size',
      'late-night added sugar and high-fat meals',
      'sleep timing consistency (bedtime variability)',
      'post-workout protein and carbohydrate fueling',
      'missed post-workout fueling sessions',
      'sleep duration as a downstream signal',
    ],
  },
};

function insightPlainLanguageExplanation(card: InsightCard, windowDays: number): string {
  const specific = PLAIN_LANGUAGE_CHECKS_BY_ID[card.id];
  if (specific) {
    return `${specific.intro} We check ${readableList(specific.checks)} over the last ${windowDays} days when those signals are available.`;
  }
  const summary = card.summary.replace(/\s+/g, ' ').trim() || briefSummary(card.summary);
  const domains = card.data_used.slice(0, 5).map(readableDataLabel);
  const checkLine = domains.length > 0
    ? `Signals checked here: ${readableList(domains)}.`
    : `This is based on the last ${windowDays} days of logs that are available for this pattern.`;
  return `${summary} ${checkLine}`;
}

function doneBullets(card: InsightCard): string[] {
  const positives = briefItems(card.positive_factors);
  if (positives.length > 0) return positives;
  if (insightSupportScore(card) >= 75) return ['Recent logs are generally supporting this area.'];
  if (card.data_used.length > 0) return [`${card.data_used.slice(0, 2).map(readableDataLabel).join(' and ')} are being tracked.`];
  return ['Keep logging so supportive habits can show up here.'];
}

function notDoneBullets(card: InsightCard): string[] {
  const gaps = briefItems([
    ...card.drivers,
    ...card.missing_data.map(item => `${readableDataLabel(item)} data is missing.`),
  ]);
  if (gaps.length > 0) return gaps;
  return ['No major gaps are showing in this window.'];
}

function improveBullets(card: InsightCard): string[] {
  const recommendations = briefItems(card.recommendations);
  if (recommendations.length > 0) return recommendations;
  return [primaryActionLine(card)];
}

function insightWindowNote(windowDays: number): string {
  const days = Math.max(1, Math.round(Number(windowDays) || 14));
  return `Based on ${days} day${days === 1 ? '' : 's'} of data.`;
}

function BriefBulletSection({
  title,
  items,
  icon,
  iconColor,
  titleColor,
  colors,
}: {
  title: string;
  items: string[];
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  titleColor?: string;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: titleColor ?? colors.textMuted }]}>{title}</Text>
      {items.map(item => (
        <View key={item} style={styles.bulletRow}>
          <Ionicons name={icon} size={13} color={iconColor} />
          <Text style={[styles.bulletText, { color: colors.textSecondary }]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

function InsightDetailSheet({
  card,
  colors,
  windowDays = 14,
  onClose,
}: {
  card: InsightCard | null;
  colors: ThemeColors;
  windowDays?: number;
  onClose: () => void;
}) {
  if (!card) return null;
  const tone = insightDisplayTone(card, colors);
  const meaning = statusMeaning(card);
  const scoreColor = insightScoreColor(card, colors);
  const attentionTone = notDoneTone(card);
  const supportDisplay = supportScoreDisplay(card);
  const explanation = insightPlainLanguageExplanation(card, windowDays);
  const doingItems = doneBullets(card);
  const gapItems = notDoneBullets(card);
  const improveItems = improveBullets(card);
  const primaryAction = primaryActionLine(card);
  const extraImproveItems = improveItems.filter(item => item !== primaryAction);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.detailSheet, { backgroundColor: colors.surface }]}>
          <BottomSheetDismissHandle
            onClose={onClose}
            color={colors.border}
            containerStyle={styles.sheetHandleTap}
            handleStyle={styles.sheetHandle}
          />
          <View style={styles.detailHeader}>
            <View style={[styles.detailIcon, { backgroundColor: tone.bg }]}>
              <Ionicons name={categoryIcon(card.category)} size={20} color={tone.text} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.detailEyebrow, { color: colors.textMuted }]} numberOfLines={1}>
                {card.category.replace(/_/g, ' ')} · {confidenceLabel(card.confidence)}
              </Text>
              <Text style={[styles.detailTitle, { color: colors.textPrimary }]} numberOfLines={2}>
                {card.title}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.iconButton}>
              <Ionicons name="close" size={21} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.detailScroll}>
            <View style={[styles.scorePanel, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
              <View style={[styles.largeScore, { backgroundColor: scoreColor + '18', borderColor: scoreColor + '66' }]}>
                <Text style={[styles.largeScoreValue, { color: scoreColor }]}>{supportDisplay}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.scoreReadLabel, { color: tone.text }]}>{meaning.label} · habit support</Text>
                <Text style={[styles.scoreReadText, { color: colors.textSecondary }]}>
                  {scoreExplanation(meaning)}
                </Text>
              </View>
            </View>

            <View style={[styles.detailActionPanel, { backgroundColor: colors.primary + '12', borderColor: colors.primary + '40' }]}>
              <View style={[styles.detailActionIcon, { backgroundColor: colors.primary + '18' }]}>
                <Ionicons name="arrow-forward-circle" size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.detailActionLabel, { color: colors.textMuted }]}>Try next</Text>
                <Text style={[styles.detailActionText, { color: colors.textPrimary }]}>{primaryAction}</Text>
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.dataWindowNote}>
                <Ionicons name="calendar-outline" size={13} color={colors.textMuted} />
                <Text style={[styles.dataWindowNoteText, { color: colors.textMuted }]}>
                  {insightWindowNote(windowDays)}
                </Text>
              </View>
              <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>What this is</Text>
              <Text style={[styles.briefText, { color: colors.textSecondary }]}>{explanation}</Text>
            </View>

            <BriefBulletSection title="What's helping" items={doingItems} icon="checkmark-circle" iconColor="#22C55E" colors={colors} />
            <BriefBulletSection title="What's holding this back" items={gapItems} icon="ellipse" iconColor={attentionTone} titleColor={attentionTone} colors={colors} />
            {extraImproveItems.length > 0 ? (
              <BriefBulletSection title="Try next" items={extraImproveItems} icon="arrow-forward-circle" iconColor={colors.primary} colors={colors} />
            ) : null}

            <Text style={[styles.footer, { color: colors.textMuted }]}>
              {card.disclaimer || 'Insights are wellness pattern estimates, not medical diagnosis.'}
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function EditInsightsSheet({
  visible,
  cards,
  hiddenIds,
  colors,
  onSetVisible,
  onShowAll,
  onClose,
}: {
  visible: boolean;
  cards: InsightCard[];
  hiddenIds: Set<string>;
  colors: ThemeColors;
  onSetVisible: (id: string, visible: boolean) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const visibleCount = cards.filter(card => !hiddenIds.has(card.id)).length;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.editSheet, { backgroundColor: colors.surface }]}>
          <BottomSheetDismissHandle
            onClose={onClose}
            color={colors.border}
            containerStyle={styles.sheetHandleTap}
            handleStyle={styles.sheetHandle}
          />
          <View style={styles.detailHeader}>
            <View style={[styles.detailIcon, { backgroundColor: colors.primary + '18' }]}>
              <Ionicons name="options-outline" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.detailEyebrow, { color: colors.textMuted }]}>
                {visibleCount} of {cards.length} shown
              </Text>
              <Text style={[styles.detailTitle, { color: colors.textPrimary }]}>Customize Insights</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.iconButton}>
              <Ionicons name="close" size={21} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.editInsightList}>
            <View style={styles.editSectionHeaderRow}>
              <Text style={[styles.editSectionLabel, { color: colors.textMuted }]}>INSIGHT CARDS</Text>
              <TouchableOpacity
                testID="health-insights-show-all"
                accessibilityLabel="health-insights-show-all"
                activeOpacity={0.78}
                onPress={onShowAll}
                style={[styles.editSheetAction, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                <Ionicons name="checkmark-done-outline" size={15} color={colors.primary} />
                <Text style={[styles.editSheetActionText, { color: colors.textPrimary }]}>Show all</Text>
              </TouchableOpacity>
            </View>
            {cards.map(card => {
              const shown = !hiddenIds.has(card.id);
              const tone = categoryTint(card.category, colors);
              return (
                <View
                  key={card.id}
                  style={[
                    styles.editInsightRow,
                    {
                      borderColor: shown ? tone + '55' : colors.border,
                      backgroundColor: shown ? tone + '10' : colors.surfaceRaised,
                      opacity: shown ? 1 : 0.72,
                    },
                  ]}>
                  <View style={[styles.editInsightIcon, { backgroundColor: tone + '18', borderColor: tone + '55' }]}>
                    <Ionicons name={categoryIcon(card.category)} size={16} color={tone} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.editInsightTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {card.title}
                    </Text>
                    <Text style={[styles.editInsightMeta, { color: colors.textMuted }]} numberOfLines={1}>
                      {insightCategoryLabel(card.category)} · {confidenceLabel(card.confidence)}
                    </Text>
                  </View>
                  <Switch
                    testID={`health-insight-visible-${card.id}`}
                    accessibilityLabel={`health-insight-visible-${card.id}`}
                    value={shown}
                    onValueChange={(next) => onSetVisible(card.id, next)}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor={shown ? getContrastingTextColor(colors.primary) : colors.textMuted}
                  />
                </View>
              );
            })}
            {cards.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No insights are available yet.</Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DataSourcesSheet({
  visible,
  data,
  colors,
  onClose,
}: {
  visible: boolean;
  data: HealthInsightsResponse | null;
  colors: ThemeColors;
  onClose: () => void;
}) {
  if (!visible) return null;
  const coverage = coverageRows(data);
  const qualityRows = Object.entries((data?.data_quality ?? {}) as Record<string, string | undefined>)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => ({ key, value: String(value) }));
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.editSheet, { backgroundColor: colors.surface }]}>
          <BottomSheetDismissHandle
            onClose={onClose}
            color={colors.border}
            containerStyle={styles.sheetHandleTap}
            handleStyle={styles.sheetHandle}
          />
          <View style={styles.detailHeader}>
            <View style={[styles.detailIcon, { backgroundColor: colors.primary + '18' }]}>
              <Ionicons name="server-outline" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.detailEyebrow, { color: colors.textMuted }]}>
                {data ? `${data.window_days}-day read` : 'Current read'}
              </Text>
              <Text style={[styles.detailTitle, { color: colors.textPrimary }]}>Data Confidence</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.iconButton}>
              <Ionicons name="close" size={21} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.sourceSheetContent}>
            <View style={[styles.sourceIntroPanel, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
              <Text style={[styles.sourceIntroTitle, { color: colors.textPrimary }]}>Current coverage</Text>
              <Text style={[styles.sourceIntroBody, { color: colors.textSecondary }]}>
                Missing inputs lower confidence instead of being treated as bad habits.
              </Text>
            </View>

            {coverage.length > 0 ? coverage.map(row => {
              const tone = qualityTone(row.item.quality, colors);
              return (
                <View key={row.key} style={[styles.sourceRow, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
                  <View style={[styles.sourceRowIcon, { backgroundColor: tone + '16' }]}>
                    <Ionicons name="analytics-outline" size={15} color={tone} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.sourceRowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {sourceLabel(row.key, row.item)}
                    </Text>
                    <Text style={[styles.sourceRowBody, { color: colors.textSecondary }]} numberOfLines={2}>
                      {coverageDisplay(row)}
                    </Text>
                  </View>
                  <View style={[styles.sourceQualityPill, { borderColor: tone + '55', backgroundColor: tone + '12' }]}>
                    <Text style={[styles.sourceQualityText, { color: tone }]} numberOfLines={1}>
                      {qualityLabel(row.item.quality)}
                    </Text>
                  </View>
                </View>
              );
            }) : (
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No coverage details are available yet.</Text>
            )}

            {qualityRows.length > 0 ? (
              <View style={styles.qualityGrid}>
                {qualityRows.map(row => {
                  const tone = qualityTone(row.value, colors);
                  return (
                    <View key={row.key} style={[styles.qualityChip, { borderColor: tone + '44', backgroundColor: tone + '10' }]}>
                      <Text style={[styles.qualityChipLabel, { color: colors.textPrimary }]} numberOfLines={1}>
                        {readableDataLabel(row.key)}
                      </Text>
                      <Text style={[styles.qualityChipValue, { color: tone }]} numberOfLines={1}>
                        {qualityLabel(row.value)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            <View style={[styles.sourceIntroPanel, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
              <Text style={[styles.sourceIntroTitle, { color: colors.textPrimary }]}>Privacy boundary</Text>
              <Text style={[styles.sourceIntroBody, { color: colors.textSecondary }]}>
                Insights use your own health, workout, meal, lab, and lifestyle logs. They are wellness pattern estimates, not diagnosis.
              </Text>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function InsightPreviewModule({ authToken, themeName, days = 14, onOpenAll }: InsightPreviewModuleProps) {
  const colors = getTheme(themeName).colors;
  const riskSignalsEnabled = isFeatureEnabled('healthInsights.riskSignals');
  const { data, loading, error } = useHealthInsights(authToken, days, false, riskSignalsEnabled);
  const { hiddenIds } = useHiddenHealthInsightIds();
  const [selectedCard, setSelectedCard] = useState<InsightCard | null>(null);
  const availableCards = useMemo(() => publishableHealthInsightCards(data?.cards ?? []), [data]);
  const cards = useMemo(() => selectPreviewCards(visibleHealthInsightCards(availableCards, hiddenIds)), [availableCards, hiddenIds]);
  const topCard = cards[0] ?? null;
  const hasHiddenInsights = !loading && !error && availableCards.length > 0 && cards.length === 0;
  useCardShownTelemetry(authToken, cards, 'preview');
  const openCard = useCallback((card: InsightCard) => {
    recordTelemetryEvent('health_insight_card_expanded', insightTelemetryPayload(card, 'preview'), authToken);
    setSelectedCard(card);
  }, [authToken]);
  return (
    <View style={[styles.previewCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.previewHeader}>
        <View style={[styles.previewIcon, { backgroundColor: colors.primary + '18' }]}>
          <Ionicons name="sparkles-outline" size={17} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.previewTitle, { color: colors.textPrimary }]}>Insights</Text>
          <Text style={[styles.previewSubtitle, { color: colors.textMuted }]}>
            {topCard ? primaryActionLine(topCard) : `${days}-day wellness patterns`}
          </Text>
        </View>
      </View>
      {loading ? (
        <View style={styles.emptyState}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : error ? (
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>Insights are unavailable right now.</Text>
      ) : cards.length === 0 ? (
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {hasHiddenInsights ? 'No selected insights to show.' : 'No risky patterns stand out yet.'}
        </Text>
      ) : (
        <View style={[styles.insightList, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          {cards.map((card, idx) => (
            <InsightListRow
              key={card.id}
              card={card}
              colors={colors}
              compact
              isLast={idx === cards.length - 1}
              onPress={() => openCard(card)}
            />
          ))}
        </View>
      )}
      {!loading && !error && cards.length > 0 && onOpenAll && (
        <TouchableOpacity
          activeOpacity={0.78}
          onPress={() => {
            if (topCard) {
              recordTelemetryEvent('health_insight_card_cta_tapped', insightTelemetryPayload(topCard, 'preview', { action: 'view_all' }), authToken);
            }
            onOpenAll();
          }}
          style={[styles.showMoreButton, { backgroundColor: colors.primary, borderColor: colors.primary }]}>
          <Text style={[styles.showMoreText, { color: getContrastingTextColor(colors.primary) }]}>View all insights</Text>
          <Ionicons name="chevron-forward" size={15} color={getContrastingTextColor(colors.primary)} />
        </TouchableOpacity>
      )}
      <Text style={[styles.footer, { color: colors.textMuted }]}>Wellness pattern estimates, not medical diagnosis.</Text>
      <InsightDetailSheet
        card={selectedCard}
        colors={colors}
        windowDays={data?.window_days ?? days}
        onClose={() => setSelectedCard(null)}
      />
    </View>
  );
}

export default function HealthInsightsScreen({ authToken, themeName, days = 14, embedded = false, showHeader = true, onClose }: HealthInsightsScreenProps) {
  const colors = getTheme(themeName).colors;
  const { width: viewportWidth } = useWindowDimensions();
  const riskSignalsEnabled = isFeatureEnabled('healthInsights.riskSignals');
  const { data, loading, error, refresh } = useHealthInsights(authToken, days, true, riskSignalsEnabled);
  const { hiddenIds, setInsightVisible, showAllInsights } = useHiddenHealthInsightIds();
  const [selectedCard, setSelectedCard] = useState<InsightCard | null>(null);
  const [editInsightsOpen, setEditInsightsOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState('all');
  const [measuredGridWidth, setMeasuredGridWidth] = useState(0);
  const allCards = useMemo(() => publishableHealthInsightCards(data?.cards ?? []).sort((a, b) => cardPriority(b) - cardPriority(a)), [data]);
  const cards = useMemo(() => visibleHealthInsightCards(allCards, hiddenIds), [allCards, hiddenIds]);
  const defaultCards = useMemo(() => {
    const ready = cards.filter(card => card.status !== 'unknown');
    return ready.length > 0 ? ready : cards;
  }, [cards]);
  const filters = useMemo(() => buildFilterOptions(cards, defaultCards), [cards, defaultCards]);
  const visibleCards = useMemo(() => {
    if (activeFilter === 'all') return defaultCards;
    if (activeFilter === 'watch') return cards.filter(insightNeedsAttention);
    return cards.filter(card => insightFilterKey(card) === activeFilter);
  }, [activeFilter, cards, defaultCards]);
  const needsDataCards = useMemo(() => cards.filter(card => card.status === 'unknown'), [cards]);
  const hiddenCount = useMemo(() => allCards.filter(card => hiddenIds.has(card.id)).length, [allCards, hiddenIds]);
  const showFilterControls = filters.length > 1 || allCards.length > 0;
  const reveal = useScrollReveal();
  const estimatedGridWidth = Math.max(0, viewportWidth - 32);
  const gridWidth = measuredGridWidth > 0 && estimatedGridWidth > 0
    ? Math.min(measuredGridWidth, estimatedGridWidth)
    : measuredGridWidth || estimatedGridWidth;
  const gridColumns = Math.max(1, Math.min(insightCardColumnCount(gridWidth), visibleCards.length || 1));
  const useInsightGrid = gridColumns > 1;
  const gridCardWidth = useInsightGrid
    ? Math.floor((gridWidth - INSIGHT_CARD_GRID_GAP * (gridColumns - 1)) / gridColumns)
    : undefined;
  useCardShownTelemetry(authToken, visibleCards, 'full');
  const openCard = useCallback((card: InsightCard) => {
    recordTelemetryEvent('health_insight_card_expanded', insightTelemetryPayload(card, 'full'), authToken);
    setSelectedCard(card);
  }, [authToken]);
  useEffect(() => {
    if (!filters.some(filter => filter.key === activeFilter)) setActiveFilter('all');
  }, [activeFilter, filters]);
  const onInsightGridLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setMeasuredGridWidth(prev => (Math.abs(prev - nextWidth) > 1 ? nextWidth : prev));
  }, []);
  const renderInsightSelectableCard = (card: InsightCard, index: number) => (
    <ScrollRevealView
      key={card.id}
      scrollY={reveal.scrollY}
      viewportHeight={reveal.viewportHeight}
      index={index}
      style={useInsightGrid && gridCardWidth ? { width: gridCardWidth } : undefined}
    >
      <InsightSelectableCard
        card={card}
        colors={colors}
        compact={useInsightGrid}
        onPress={() => openCard(card)}
      />
    </ScrollRevealView>
  );
  return (
    <View style={[styles.container, !embedded && { backgroundColor: colors.background }]}>
      {showHeader && <View style={[styles.header, { borderColor: colors.border }]}>
        <View style={[styles.previewIcon, { backgroundColor: colors.primary + '18' }]}>
          <Ionicons name="sparkles-outline" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>Insights</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            {data ? `${data.window_days}-day wellness patterns` : `${days}-day wellness patterns`}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Customize insight cards"
            onPress={() => setEditInsightsOpen(true)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.iconButton}>
            <Ionicons name="options-outline" size={19} color={colors.textMuted} />
          </TouchableOpacity>
          {onClose ? (
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.iconButton}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={refresh} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.iconButton}>
              <Ionicons name="refresh" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>}
      {loading ? (
        <View style={styles.fullEmpty}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.fullEmpty}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{error}</Text>
        </View>
      ) : (
        <Animated.ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, embedded && styles.embeddedScrollContent]}
          showsVerticalScrollIndicator={false}
          onLayout={reveal.onLayout}
          onScroll={reveal.onScroll}
          scrollEventThrottle={16}
        >
          {showFilterControls && (
            <ScrollRevealView scrollY={reveal.scrollY} viewportHeight={reveal.viewportHeight} index={0}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                {allCards.length > 0 ? (
                  <TouchableOpacity
                    activeOpacity={0.78}
                    accessibilityRole="button"
                    accessibilityLabel="Customize insight cards"
                    onPress={() => setEditInsightsOpen(true)}
                    style={[
                      styles.filterChip,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                      },
                    ]}>
                    <Ionicons name="options-outline" size={14} color={colors.textSecondary} />
                    <Text style={[styles.filterChipText, { color: colors.textSecondary }]}>
                      Cards
                    </Text>
                    {hiddenCount > 0 ? (
                      <View style={[styles.filterCount, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
                        <Text style={[styles.filterCountText, { color: colors.textMuted }]}>
                          {hiddenCount}
                        </Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                ) : null}
                {filters.length > 1 ? filters.map(filter => {
                  const active = activeFilter === filter.key;
                  return (
                    <TouchableOpacity
                      key={filter.key}
                      activeOpacity={0.78}
                      onPress={() => setActiveFilter(filter.key)}
                      style={[
                        styles.filterChip,
                        {
                          backgroundColor: active ? colors.primary : colors.surface,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}>
                      <Text style={[styles.filterChipText, { color: active ? getContrastingTextColor(colors.primary) : colors.textSecondary }]}>
                        {filter.label}
                      </Text>
                      <View style={[styles.filterCount, { backgroundColor: active ? getContrastingTextColor(colors.primary) + '22' : colors.surfaceRaised, borderColor: active ? getContrastingTextColor(colors.primary) + '55' : colors.border }]}>
                        <Text style={[styles.filterCountText, { color: active ? getContrastingTextColor(colors.primary) : colors.textMuted }]}>
                          {filter.count}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                }) : null}
              </ScrollView>
            </ScrollRevealView>
          )}
          {activeFilter === 'all' && needsDataCards.length > 0 ? (
            <ScrollRevealView scrollY={reveal.scrollY} viewportHeight={reveal.viewportHeight} index={1}>
              <NeedsDataPrompt
                count={needsDataCards.length}
                cards={needsDataCards}
                colors={colors}
                onPress={() => setActiveFilter('needs_data')}
              />
            </ScrollRevealView>
          ) : null}
          {visibleCards.length > 0 ? (
            <View
              onLayout={onInsightGridLayout}
              style={[styles.stackedInsightList, useInsightGrid && styles.stackedInsightGrid]}>
              {visibleCards.map((card, index) => renderInsightSelectableCard(card, index + 2))}
            </View>
          ) : (
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {allCards.length > 0 && cards.length === 0
                ? 'All insights are hidden. Customize cards to add some back.'
                : 'No insights match this filter yet.'}
            </Text>
          )}
          <ScrollRevealView scrollY={reveal.scrollY} viewportHeight={reveal.viewportHeight} index={visibleCards.length + 3}>
            <Text style={[styles.footer, { color: colors.textMuted }]}>Wellness pattern estimates, not medical diagnosis.</Text>
          </ScrollRevealView>
        </Animated.ScrollView>
      )}
      <InsightDetailSheet
        card={selectedCard}
        colors={colors}
        windowDays={data?.window_days ?? days}
        onClose={() => setSelectedCard(null)}
      />
      <EditInsightsSheet
        visible={editInsightsOpen}
        cards={allCards}
        hiddenIds={hiddenIds}
        colors={colors}
        onSetVisible={setInsightVisible}
        onShowAll={showAllInsights}
        onClose={() => setEditInsightsOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 20, fontWeight: '900' },
  subtitle: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24, gap: 12 },
  embeddedScrollContent: { paddingBottom: 140 },
  previewCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 14,
  },
  previewHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  previewIcon: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  previewTitle: { fontSize: 16, fontWeight: '900' },
  previewSubtitle: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  overviewCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 12,
  },
  overviewHero: {
    minHeight: 172,
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  overviewHeroImage: { borderRadius: 8 },
  overviewHeroMeta: {
    padding: 13,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  overviewHeroIcon: { width: 38, height: 38, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  overviewHeroEyebrow: { fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase', color: '#FFFFFF' },
  overviewHeroTitle: { fontSize: 20, lineHeight: 24, fontWeight: '900', marginTop: 1, color: '#FFFFFF' },
  overviewHeroSummary: { fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 5, color: '#FFFFFFE6' },
  overviewStatsRow: { flexDirection: 'row', gap: 8 },
  overviewStat: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 6, alignItems: 'center' },
  overviewStatValue: { fontSize: 17, lineHeight: 21, fontWeight: '900' },
  overviewStatLabel: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase', marginTop: 1 },
  healthConfidenceRow: {
    minHeight: 54,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  healthConfidenceIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  healthConfidenceCopy: { flex: 1, minWidth: 0 },
  healthConfidenceLabel: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  healthConfidenceDetail: { fontSize: 11, lineHeight: 15, fontWeight: '700', marginTop: 1 },
  overviewActions: { flexDirection: 'row', gap: 8 },
  overviewActionButton: { flex: 1, minHeight: 38, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  overviewActionText: { fontSize: 12, lineHeight: 16, fontWeight: '900' },
  needsDataPrompt: {
    minHeight: 66,
    borderWidth: 1,
    borderRadius: 8,
    padding: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  needsDataIcon: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  needsDataTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  needsDataBody: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  priorityCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 13,
    gap: 11,
    overflow: 'hidden',
  },
  priorityAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, opacity: 0.9 },
  priorityHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  priorityIcon: { width: 38, height: 38, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  priorityEyebrow: { fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase' },
  priorityTitle: { fontSize: 17, lineHeight: 22, fontWeight: '900', marginTop: 2 },
  priorityScore: { minWidth: 56, height: 52, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  priorityScoreValue: { fontSize: 18, lineHeight: 21, fontWeight: '900' },
  priorityScoreLabel: { fontSize: 8, lineHeight: 10, fontWeight: '900', textTransform: 'uppercase' },
  priorityWhy: { fontSize: 12, lineHeight: 18 },
  priorityActionBox: { borderWidth: 1, borderRadius: 8, padding: 10, flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  priorityActionIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  priorityActionLabel: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  priorityActionText: { fontSize: 13, lineHeight: 18, fontWeight: '800', marginTop: 1 },
  priorityMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  priorityMetaPill: { minHeight: 26, borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center' },
  priorityMetaText: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  priorityOpen: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 26 },
  priorityOpenText: { fontSize: 11, fontWeight: '900' },
  patternGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  patternReveal: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 150,
  },
  insightSectionHeader: {
    width: '100%',
    marginTop: 2,
  },
  insightSectionTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  patternCard: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 8,
    padding: 11,
    minHeight: 184,
  },
  patternHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  patternIcon: { width: 34, height: 34, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  patternScoreBadge: { minWidth: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  patternScoreValue: { fontSize: 13, lineHeight: 16, fontWeight: '900' },
  patternCategory: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase', marginTop: 10 },
  patternTitle: { fontSize: 14, lineHeight: 18, fontWeight: '900', marginTop: 3 },
  patternSignalTrack: { height: 5, borderRadius: 999, backgroundColor: '#8A8A8A24', overflow: 'hidden', marginTop: 10 },
  patternSignalFill: { height: '100%', borderRadius: 999 },
  patternMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9 },
  patternStatusPill: { flexShrink: 1, minHeight: 23, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  patternStatusText: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  patternConfidence: { flex: 1, minWidth: 0, fontSize: 10, lineHeight: 13, fontWeight: '800' },
  patternAction: { fontSize: 11, lineHeight: 15, marginTop: 8 },
  filterRow: {
    gap: 8,
    paddingRight: 4,
  },
  filterChip: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  filterChipText: { fontSize: 12, fontWeight: '900' },
  filterCount: { minWidth: 22, height: 22, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  filterCountText: { fontSize: 10, lineHeight: 13, fontWeight: '900' },
  stackedInsightList: {
    width: '100%',
    gap: 12,
  },
  stackedInsightGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    gap: INSIGHT_CARD_GRID_GAP,
  },
  stackedInsightCard: {
    minHeight: 218,
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  compactStackedInsightCard: {
    minHeight: 208,
  },
  stackedInsightAccent: {
    position: 'absolute',
    left: 0,
    top: 9,
    bottom: 9,
    width: 3,
    borderRadius: 999,
    opacity: 0.86,
  },
  stackedInsightImageWrap: {
    minHeight: 218,
    padding: 12,
    overflow: 'hidden',
    justifyContent: 'space-between',
  },
  compactStackedInsightImageWrap: {
    minHeight: 208,
    padding: 10,
  },
  stackedInsightImage: { borderRadius: 8 },
  stackedInsightTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  stackedInsightCategoryPill: {
    flex: 1,
    minWidth: 0,
    minHeight: 32,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  compactStackedInsightCategoryPill: {
    minHeight: 30,
    paddingHorizontal: 7,
    gap: 4,
  },
  stackedInsightCategoryText: { flex: 1, minWidth: 0, fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase', color: '#FFFFFF' },
  compactStackedInsightCategoryText: { fontSize: 9, lineHeight: 12 },
  stackedInsightBottom: { gap: 9 },
  stackedInsightTitle: { fontSize: 20, lineHeight: 24, fontWeight: '900', color: '#FFFFFF' },
  compactStackedInsightTitle: { fontSize: 17, lineHeight: 21 },
  stackedInsightActionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  stackedInsightActionText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, fontWeight: '700', color: '#FFFFFFD9' },
  compactStackedInsightActionText: { fontSize: 11, lineHeight: 15 },
  stackedInsightActionLead: { fontWeight: '900', color: '#FFFFFF' },
  stackedInsightFooterRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  stackedInsightConfidence: { flex: 1, minWidth: 0, fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase', color: '#FFFFFFB8' },
  stackedInsightDetails: { minHeight: 28, borderRadius: 8, paddingLeft: 9, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 1, backgroundColor: 'rgba(255,255,255,0.16)' },
  stackedInsightDetailsText: { fontSize: 11, lineHeight: 14, fontWeight: '900', color: '#FFFFFF' },
  stackedInsightImageIcon: { width: 22, height: 22, borderTopRightRadius: 8, alignItems: 'center', justifyContent: 'center' },
  stackedInsightCopy: { flex: 1, minWidth: 0 },
  stackedInsightMeta: { fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase', marginTop: 3 },
  stackedInsightScore: {
    minWidth: 54,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  compactStackedInsightScore: {
    minWidth: 46,
    height: 40,
    paddingHorizontal: 5,
  },
  stackedInsightScoreValue: { fontSize: 15, lineHeight: 18, fontWeight: '900' },
  stackedInsightScoreLabel: { fontSize: 8, lineHeight: 10, fontWeight: '900', textTransform: 'uppercase', color: '#FFFFFFB8' },
  insightList: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  insightRow: {
    minHeight: 88,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  compactInsightRow: {
    minHeight: 80,
    paddingVertical: 8,
  },
  rowAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 999,
    opacity: 0.78,
  },
  rowImageWrap: {
    width: 46,
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
  },
  rowImage: { borderRadius: 10 },
  rowImageIcon: { width: 20, height: 20, borderTopRightRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowCopy: { flex: 1, minWidth: 0 },
  rowMeta: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase', marginBottom: 2 },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 18, fontWeight: '900' },
  rowMetric: { fontSize: 12, lineHeight: 16, marginTop: 2, fontWeight: '800' },
  rowAction: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  rowActionText: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: 15 },
  rowScoreWrap: { alignItems: 'center', justifyContent: 'center', gap: 5 },
  rowScoreBadge: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  rowScoreValue: { fontSize: 13, fontWeight: '900' },
  showMoreButton: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  showMoreText: { fontSize: 12, fontWeight: '900' },
  emptyState: { paddingVertical: 12, alignItems: 'center' },
  fullEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
  footer: { fontSize: 10, lineHeight: 14, marginTop: 8 },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: '#00000088',
  },
  detailSheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 26,
  },
  editSheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 26,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetHandleTap: {
    minHeight: 28,
    justifyContent: 'flex-start',
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 12 },
  detailIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  detailEyebrow: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4, textTransform: 'capitalize' },
  detailTitle: { fontSize: 17, lineHeight: 22, fontWeight: '900', marginTop: 2 },
  sheetScroll: { flexShrink: 1 },
  detailScroll: { paddingBottom: 22, gap: 12 },
  dataWindowNote: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },
  dataWindowNoteText: { fontSize: 10, lineHeight: 14, fontWeight: '800' },
  editSectionBlock: { gap: 8, marginBottom: 4 },
  editSectionHeaderRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  editSectionLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 0, textTransform: 'uppercase' },
  editSheetAction: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editSheetActionText: { fontSize: 12, fontWeight: '900' },
  editInsightList: { gap: 8, paddingBottom: 22 },
  editInsightRow: {
    minHeight: 58,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  editInsightIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editInsightTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  editInsightMeta: { fontSize: 10, lineHeight: 14, fontWeight: '800', marginTop: 1 },
  sourceSheetContent: { gap: 9, paddingBottom: 22 },
  sourceIntroPanel: { borderWidth: 1, borderRadius: 8, padding: 11, gap: 4 },
  sourceIntroTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  sourceIntroBody: { fontSize: 11, lineHeight: 16 },
  sourceRow: {
    minHeight: 62,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sourceRowIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sourceRowTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  sourceRowBody: { fontSize: 10, lineHeight: 14, fontWeight: '700', marginTop: 1 },
  sourceQualityPill: { minHeight: 24, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  sourceQualityText: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  qualityGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  qualityChip: { flexGrow: 1, flexBasis: '47%', minWidth: 132, borderWidth: 1, borderRadius: 8, padding: 9 },
  qualityChipLabel: { fontSize: 10, lineHeight: 13, fontWeight: '900' },
  qualityChipValue: { fontSize: 10, lineHeight: 13, fontWeight: '800', marginTop: 2 },
  scorePanel: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  largeScore: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  largeScoreValue: { fontSize: 23, fontWeight: '900' },
  scoreReadLabel: { fontSize: 14, fontWeight: '900' },
  scoreReadText: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  detailActionPanel: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 11,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  detailActionIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  detailActionLabel: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  detailActionText: { fontSize: 13, lineHeight: 18, fontWeight: '800', marginTop: 1 },
  section: { gap: 7, marginTop: 1 },
  sectionTitle: { fontSize: 9, fontWeight: '900', letterSpacing: 0, textTransform: 'uppercase' },
  briefText: { fontSize: 12, lineHeight: 17 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  bulletText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17 },
});
