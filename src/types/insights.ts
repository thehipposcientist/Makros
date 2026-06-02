export type InsightStatus = 'low' | 'watch' | 'moderate' | 'elevated' | 'high' | 'unknown';
export type InsightRiskDirection = 'higher_is_better' | 'higher_is_worse';
export type InsightConfidence = 'low' | 'medium' | 'high';

export interface InsightCard {
  id: string;
  title: string;
  category: string;
  status: InsightStatus;
  score: number;
  risk_direction: InsightRiskDirection;
  confidence: InsightConfidence;
  confidence_reasons: string[];
  summary: string;
  drivers: string[];
  positive_factors: string[];
  recommendations: string[];
  disclaimer: string;
  data_used: string[];
  missing_data: string[];
  generated_at: string;
}

export interface InsightDataQuality {
  nutrition: InsightConfidence;
  sleep: InsightConfidence;
  activity: InsightConfidence;
  apple_health: InsightConfidence;
  hydration: InsightConfidence;
  micronutrients?: InsightConfidence;
  cycle?: InsightConfidence | 'not_opted_in';
  labs?: InsightConfidence | 'missing';
  recovery_modalities?: InsightConfidence;
}

export interface InsightDataCoverageItem {
  label: string;
  window_days?: number;
  days_with_data?: number;
  records?: number;
  unit?: string;
  quality?: InsightConfidence | 'missing' | 'not_opted_in';
  display: string;
}

export type InsightDataCoverage = Record<string, InsightDataCoverageItem>;

export interface HealthInsightsResponse {
  user_id: string;
  window_days: number;
  generated_at: string;
  cards: InsightCard[];
  overall_summary: string;
  feature_flags?: Record<string, boolean>;
  data_coverage?: InsightDataCoverage;
  data_quality: InsightDataQuality;
}

export type ContextInsightCategory = 'move' | 'recover' | 'environment' | 'connect' | 'improve';

export interface ContextAwareInsight {
  id: string;
  userId: number;
  type: string;
  category: ContextInsightCategory;
  title: string;
  summary: string;
  recommendedAction: string;
  confidence: InsightConfidence;
  dataSources: string[];
  explanation: string;
  safetyNote?: string | null;
  createdAt: string;
  validUntil?: string | null;
  dismissedAt?: string | null;
  why?: string | null;
  payload?: Record<string, any>;
}

export interface ContextSegment {
  id: string | number;
  userId: number;
  startTime: string;
  endTime: string;
  coarseLocationHash?: string | null;
  placeCategory?: string | null;
  activityType?: string | null;
  workoutId?: number | null;
  daylight?: boolean | null;
  uvIndex?: number | null;
  airQualityIndex?: number | null;
  temperature?: number | null;
  humidity?: number | null;
  elevationGainMeters?: number | null;
  steps?: number | null;
  heartRateAvg?: number | null;
  socialContext?: 'alone' | 'with_friend' | 'group' | 'unknown' | null;
  confidence: InsightConfidence;
  source: string[];
}

export interface DailyFeatureSet {
  userId: number;
  date: string;
  steps: number;
  activeMinutes: number;
  strengthWorkoutCount: number;
  weightBearingMinutes: number;
  mobilityMinutes: number;
  elevationGainMeters: number;
  outdoorDaylightMinutes: number;
  openSkyEquivalentMinutes: number;
  highUvMinutes: number;
  sleepDurationMinutes?: number | null;
  sleepConsistencyScore?: number | null;
  restingHeartRate?: number | null;
  hrv?: number | null;
  workoutLoad?: number | null;
  recoveryScore?: number | null;
  socialActivityCount?: number | null;
  activeCommuteMinutes?: number | null;
  sedentaryBlockMinutes?: number | null;
}

export interface UserInsightPreferences {
  enableMoveInsights: boolean;
  enableRecoveryInsights: boolean;
  enableEnvironmentInsights: boolean;
  enableSocialInsights: boolean;
  enablePatternInsights: boolean;
  useCoarseLocation: boolean;
  useWorkoutRoutes: boolean;
  useWeatherEnvironmentData: boolean;
  useSocialContext: boolean;
  allowNotifications: boolean;
  allowOccasionalCorrectionPrompts: boolean;
}

export interface DailyInsightAction {
  primaryAction: string;
  reason: string;
  expectedBenefit: string;
  insightId?: string | null;
  secondaryAction?: string | null;
}

export interface ContextInsightsResponse {
  userId: number;
  generatedAt: string;
  preferences: UserInsightPreferences;
  insights: ContextAwareInsight[];
  nextBestAction: DailyInsightAction;
}
