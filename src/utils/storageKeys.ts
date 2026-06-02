/**
 * Central AsyncStorage key registry.
 *
 * SavedDatabaseEntity: canonical rows that must live in backend tables.
 * CachedFetchedEntity: local copy of backend data, safe to delete/refetch.
 * LocalDraftEntity: unsaved/crash-recovery state, never treated as saved.
 * OptimisticTemporaryEntity: pending mutation state with server reconciliation.
 */

export const STORAGE_KEYS = {
  app: {
    installMarker: 'install_marker_v1',
    legacyInstallMarker: 'installMarker',
    cacheVersion: 'cacheVersion',
    lastUserId: 'last_user_id',
    tutorialCompleted: 'tutorial_v1_completed',
    liveTutorialCompleted: 'live_tutorial_v1_completed',
    legalLocalAcceptedVersion: 'legal_locally_accepted_version',
    lastActiveTab: 'lastActiveTab',
    settings: 'appSettings',
  },
  auth: {
    token: 'auth_token',
    tokenV2: 'auth_token_v2',
    legacyToken: 'authToken',
  },
  userState: {
    legacyCanonicalQuarantine: 'legacyCanonicalStateQuarantine_v1',
    dbSourceOfTruthMarker: 'db_source_of_truth_v1',
  },
  plan: {
    pendingGeneration: 'plan_gen_pending',
    pendingJob: 'pending_plan_job',
    weekStartDate: 'weekStartDate',
    aiWorkoutPlan: 'aiWorkoutPlan',
    aiNutritionPlan: 'aiNutritionPlan',
    aiNutritionPlanA: 'aiNutritionPlanA',
    aiNutritionPlanB: 'aiNutritionPlanB',
    aiNutritionPlanC: 'aiNutritionPlanC',
    aiNutritionPlans: 'aiNutritionPlans',
    freshDayGeneratedPrefix: 'freshDayGenerated_',
  },
  profile: {
    userProfile: 'userProfile',
    username: 'user_username',
    pendingProfileChanges: 'pendingProfileChanges',
    accountMeCache: 'accountModal.meCache.v1',
  },
  meals: {
    checks: 'mealChecks',
    checksPrefix: 'mealChecks_',
    edits: 'mealEdits',
    preservedChecked: 'preservedCheckedMeals',
    routines: 'mealRoutines',
    planPrefix: 'mealPlan_',
    preservedPrefix: 'preservedMeal_',
    checkTimestamps: 'mealCheckTimestamps',
    reviewPromptShownPrefix: 'mealReviewPromptShown_',
    unloggedPromptShownPrefix: 'unloggedMealsPromptShown_',
  },
  workouts: {
    history: 'workoutHistory',
    skipped: 'skippedWorkouts',
    summaries: 'workoutSummaries',
    goalHistory: 'goalHistory',
    planChangeHistory: 'planChangeHistory',
    templates: 'workoutTemplates',
    templateDeletedIds: 'workoutTemplateDeletedIds',
    preservedCompleted: 'preservedCompletedWorkouts',
    manualOverrides: 'manualWorkoutOverrides',
    pendingCompletions: 'pendingWorkoutCompletions_v1',
    activeSession: 'activeWorkoutSession',
    activeSets: 'activeWorkoutSets',
    activeRest: 'activeWorkoutRest',
    activeStartTime: 'activeWorkoutStartTime',
    activeTimers: 'activeWorkoutTimers',
    activeWatchSessionId: 'activeWatchSessionId',
    activePausedAtMs: 'activeWorkoutPausedAtMs',
    activePausedAccumMs: 'activeWorkoutPausedAccumMs',
  },
  cache: {
    readCachePrefix: 'read_cache_v2::',
    readCacheIndex: 'read_cache_v2_index',
    legacyReadCachePrefix: 'read_cache_v1::',
    legacyReadCacheIndex: 'read_cache_v1_index',
    metaDataV1: 'metaData_v1',
    metaDataV4: 'metaData_v4',
    exerciseLibraryV2: 'exerciseLibraryCache_v2',
    exerciseLibraryV5: 'exercise_library_cache_v5',
    exerciseImages: 'exercise_image_map_v1',
    healthDataSummary: 'healthDataSummary_v2',
    healthBackfillStatus: 'healthBackfillStatus_v1',
    hrZones: 'hrZonesCache_v1',
  },
  health: {
    summary: 'healthSummary',
    score: 'healthScoreResult',
    appleHealthEnabled: 'appleHealthEnabled',
    hydrationByDate: 'hydrationByDate_v1',
    sleepHistory: 'sleepHistory_v1',
    weightHistory: 'weightHistory',
    weightHistoryQuarantine: 'legacyWeightHistoryQuarantine_v1',
    bodyScanHistory: 'bodyScanHistory',
    bodyScanHistoryQuarantine: 'legacyBodyScanHistoryQuarantine_v1',
    periodSymptomLogs: 'periodSymptomLogs_v1',
    periodSymptomLogCache: 'periodSymptomLogsCache_v1',
    periodSymptomLogQuarantine: 'periodSymptomLogsQuarantine_v1',
    pendingLifestyleLogs: 'pendingLifestyleLogs_v1',
    thalloScoreHistory: 'thalloScoreHistory',
    thalloScoreDailySnapshot: 'thalloScoreDailySnapshot',
    dailyRecompForecastSnapshot: 'dailyRecompForecastSnapshot',
  },
  ui: {
    emailBannerDismissedAt: 'emailBannerDismissedAt',
    birthdateBackfillDismissed: 'birthdateBackfill_dismissed_v1',
    hkImportDismissed: 'hkImportDismissed_v1',
    incompleteDayDismissedPrefix: 'incompleteDayDismissed_',
    birthdayDismissedPrefix: 'birthday_dismissed_',
    lastDigestDismissedWeekPrefix: 'lastDigestDismissedWeek_',
    weeklyReviewDismissedPrefix: 'weeklyReviewDismissed_v1_',
    routineOverlayShownPrefix: 'routineOverlayShown_',
    trendsHiddenSections: 'trendsHiddenSections_v1',
    healthHiddenSections: 'healthHiddenSections_v1',
    highValueTrendHiddenCards: 'highValueTrendHiddenCards_v1',
    activityHighlightHiddenCards: 'activityHighlightHiddenCards_v1',
    hiddenHealthInsightIds: 'thallo.hiddenHealthInsightIds.v1',
    plateauDismissedAt: 'plateauDismissedAt',
  },
  reminders: {
    mealSettings: 'meal_reminder_settings',
    mealNotificationId: 'meal_reminder_notification_id',
    mealIds: 'meal_reminder_ids',
    hydrationSettings: 'hydration_reminder_settings',
    hydrationIds: 'hydration_reminder_ids',
    workoutSettings: 'workout_reminder_settings',
    workoutIds: 'workout_reminder_ids',
    quietHours: 'notification_quiet_hours',
    weeklyCheckinSentIds: 'weekly_checkin_notification_sent_ids',
    sleepScoreSettings: 'sleep_score_notification_settings',
    sleepScoreSentNights: 'sleep_score_notification_sent_nights',
    readinessSettings: 'readiness_notification_settings',
    readinessSentDates: 'readiness_notification_sent_dates',
    coachingSettings: 'coaching_notification_settings',
    coachingPlanIds: 'coaching_notification_plan_ids',
    postWorkoutMealId: 'post_workout_meal_notification_id',
    newPlanWeekSentIds: 'new_plan_week_notification_sent_ids',
    pendingImportIds: 'pending_import_reminder_ids',
    stalenessWatches: 'staleness_watches',
    stalenessWatchIds: 'staleness_watch_ids',
  },
  watch: {
    syncStatus: 'watch_sync_status_v1',
    commandBacklog: 'watch_active_command_backlog_v1',
  },
  grocery: {
    checked: 'groceryChecked_v2',
    removed: 'groceryRemoved_v2',
  },
  drafts: {
    onboarding: 'onboardingDraft_v1',
  },
} as const;

export const DB_CANONICAL_ASYNC_STORAGE_KEYS = [
  STORAGE_KEYS.profile.userProfile,
  STORAGE_KEYS.plan.aiWorkoutPlan,
  STORAGE_KEYS.plan.aiNutritionPlan,
  STORAGE_KEYS.plan.aiNutritionPlanA,
  STORAGE_KEYS.plan.aiNutritionPlanB,
  STORAGE_KEYS.plan.aiNutritionPlanC,
  STORAGE_KEYS.plan.aiNutritionPlans,
  STORAGE_KEYS.plan.weekStartDate,
  STORAGE_KEYS.workouts.history,
  STORAGE_KEYS.workouts.skipped,
  STORAGE_KEYS.workouts.summaries,
  STORAGE_KEYS.workouts.goalHistory,
  STORAGE_KEYS.workouts.planChangeHistory,
  STORAGE_KEYS.workouts.preservedCompleted,
  STORAGE_KEYS.workouts.manualOverrides,
  STORAGE_KEYS.health.weightHistory,
  STORAGE_KEYS.health.bodyScanHistory,
] as const;

export const DB_CANONICAL_USER_STATE_KEYS = new Set<string>(DB_CANONICAL_ASYNC_STORAGE_KEYS);

// The old /profile/state blob must no longer carry real user data. Keeping
// this empty intentionally clears stale legacy blobs on the next push.
export const USER_STATE_SYNC_KEYS: readonly string[] = [];

export function isDbCanonicalUserStateKey(key: string): boolean {
  return DB_CANONICAL_USER_STATE_KEYS.has(key);
}
