import type { ContextAwareInsight, ContextInsightCategory, InsightConfidence, UserInsightPreferences } from '../types/insights';

export const DEFAULT_USER_INSIGHT_PREFERENCES: UserInsightPreferences = {
  enableMoveInsights: false,
  enableRecoveryInsights: false,
  enableEnvironmentInsights: false,
  enableSocialInsights: false,
  enablePatternInsights: false,
  useCoarseLocation: false,
  useWorkoutRoutes: false,
  useWeatherEnvironmentData: false,
  useSocialContext: false,
  allowNotifications: false,
  allowOccasionalCorrectionPrompts: false,
};

const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

export function normalizeUserInsightPreferences(value: Partial<UserInsightPreferences> | null | undefined): UserInsightPreferences {
  const incoming = value && typeof value === 'object' ? value : {};
  const next = { ...DEFAULT_USER_INSIGHT_PREFERENCES, ...incoming };
  if (!next.useCoarseLocation && !next.useWorkoutRoutes) {
    next.useWeatherEnvironmentData = false;
  }
  if (!next.enableSocialInsights) {
    next.useSocialContext = false;
  }
  return next;
}

export function contextInsightConfidenceLabel(confidence: InsightConfidence | string | null | undefined): string {
  const value = String(confidence || 'low').toLowerCase();
  const normalized = VALID_CONFIDENCE.has(value) ? value : 'low';
  return `${normalized[0].toUpperCase()}${normalized.slice(1)} confidence`;
}

export function contextInsightCategoryLabel(category: ContextInsightCategory | string): string {
  switch (category) {
    case 'move': return 'Move';
    case 'recover': return 'Recover';
    case 'environment': return 'Environment';
    case 'connect': return 'Connect';
    case 'improve': return 'Improve';
    default: return 'Insight';
  }
}

export function contextInsightCategoryIcon(category: ContextInsightCategory | string): string {
  switch (category) {
    case 'move': return 'walk-outline';
    case 'recover': return 'bed-outline';
    case 'environment': return 'partly-sunny-outline';
    case 'connect': return 'people-outline';
    case 'improve': return 'sparkles-outline';
    default: return 'bulb-outline';
  }
}

export function contextInsightTone(category: ContextInsightCategory | string): string {
  switch (category) {
    case 'move': return '#16A34A';
    case 'recover': return '#2563EB';
    case 'environment': return '#D97706';
    case 'connect': return '#7C3AED';
    case 'improve': return '#0F766E';
    default: return '#64748B';
  }
}

export function assertContextInsightCopyIsSafe(copy: string): boolean {
  const lowered = copy.toLowerCase();
  return !lowered.includes('bone density score')
    && !lowered.includes('vitamin d dose')
    && !lowered.includes('vitamin d production')
    && !lowered.includes('you are lonely')
    && !lowered.includes('friend location');
}

export function contextInsightCopy(insight: ContextAwareInsight): string {
  return [
    insight.title,
    insight.summary,
    insight.recommendedAction,
    insight.explanation,
    insight.safetyNote ?? '',
    insight.why ?? '',
  ].join(' ');
}

