// Typed analytics taxonomy.
//
// Every product-meaningful event in the app should fire through one of
// these helpers — not raw `recordTelemetryEvent('foo')` calls. The
// typed surface gives us:
//
//   * a single grep target when we ask "where do we track signup?"
//   * autocomplete on payload shapes
//   * a single place to fan out to multiple sinks (server-side
//     warehouse via the existing /telemetry/events endpoint, Sentry
//     breadcrumbs for debug context, PostHog if/when wired up)
//   * a stable funnel definition that survives renaming
//
// Sinks:
//   * Server: `recordTelemetryEvent` already POSTs to /telemetry/events
//     and lands in the `client_telemetry_events` table. That's the
//     primary source-of-truth — survives reinstalls and lets us do
//     SQL-driven cohort analysis without a third-party.
//   * Sentry: breadcrumbs only. Sentry isn't a product analytics tool,
//     but breadcrumbs make crashed-during-signup diagnoses trivial.
//   * PostHog (future): the `_loadPostHog` shim is here so a future
//     `npx expo install posthog-react-native` + DSN env enables product
//     funnels without changing call sites.

import { recordTelemetryEvent } from './api';
import { addBreadcrumb } from './observability';

type EventName =
  // Funnel
  | 'app_open'
  | 'signup_started'
  | 'signup_complete'
  | 'onboarding_step_view'
  | 'onboarding_complete'
  | 'first_workout_logged'
  | 'first_meal_logged'
  | 'first_weight_logged'
  // Engagement
  | 'workout_complete'
  | 'meal_log'
  | 'streak_milestone'
  | 'pr_achieved'
  // AI coach
  | 'coach_checkin_submit'
  | 'coach_action_apply'
  | 'coach_action_undo'
  // Monetization
  | 'paywall_view'
  | 'pro_upgrade_start'
  | 'pro_upgrade_complete'
  | 'trial_start'
  | 'trial_expired'
  // Social
  | 'friend_added'
  | 'workout_shared'
  | 'template_shared'
  | 'template_imported'
  // Wearables / imports
  | 'wearable_connected'
  | 'import_started'
  | 'import_completed'
  // Errors (non-fatal — fatal crashes go through observability)
  | 'feature_error';

interface BaseProps {
  /** Auth token, when known. Telemetry events without one are still
   *  recorded against the `anonymous_id` install marker. */
  token?: string;
}

async function _track(event: EventName, payload: Record<string, any>, token?: string): Promise<void> {
  // Sink #1 — server-side warehouse.
  try {
    await recordTelemetryEvent(event, payload, token);
  } catch { /* recordTelemetryEvent already swallows; defensive */ }
  // Sink #2 — Sentry breadcrumb so crashes downstream carry funnel
  // context. Pure no-op when Sentry isn't installed.
  addBreadcrumb({
    category: 'analytics',
    message: event,
    data: payload,
    level: event === 'feature_error' ? 'warning' : 'info',
  });
}

// ─── Funnel events ──────────────────────────────────────────────────────────

export const analytics = {
  appOpen(props: BaseProps = {}): void {
    void _track('app_open', {}, props.token);
  },
  signupStarted(props: BaseProps & { method: 'email' | 'apple' | 'google' }): void {
    void _track('signup_started', { method: props.method }, props.token);
  },
  signupComplete(props: BaseProps & { method: 'email' | 'apple' | 'google'; user_id?: number }): void {
    void _track('signup_complete', { method: props.method, user_id: props.user_id }, props.token);
  },
  onboardingStepView(props: BaseProps & { step: string; step_index: number }): void {
    void _track('onboarding_step_view', { step: props.step, step_index: props.step_index }, props.token);
  },
  onboardingComplete(props: BaseProps & { goal: string; pace?: string; took_seconds?: number }): void {
    void _track('onboarding_complete', { goal: props.goal, pace: props.pace, took_seconds: props.took_seconds }, props.token);
  },

  // ── Engagement ────────────────────────────────────────────────────────────
  firstWorkoutLogged(props: BaseProps & { source: 'manual' | 'plan' | 'watch' | 'import' }): void {
    void _track('first_workout_logged', { source: props.source }, props.token);
  },
  firstMealLogged(props: BaseProps & { source: 'manual' | 'scan' | 'plan' | 'favorite' | 'routine' | 'import' }): void {
    void _track('first_meal_logged', { source: props.source }, props.token);
  },
  firstWeightLogged(props: BaseProps = {}): void {
    void _track('first_weight_logged', {}, props.token);
  },
  workoutComplete(props: BaseProps & { focus?: string; duration_seconds?: number; source?: string }): void {
    void _track('workout_complete', { focus: props.focus, duration_seconds: props.duration_seconds, source: props.source }, props.token);
  },
  mealLog(props: BaseProps & { source: string; meal_type?: string; item_count?: number }): void {
    void _track('meal_log', { source: props.source, meal_type: props.meal_type, item_count: props.item_count }, props.token);
  },
  streakMilestone(props: BaseProps & { kind: 'workout' | 'meal' | 'readiness'; days: number }): void {
    void _track('streak_milestone', { kind: props.kind, days: props.days }, props.token);
  },
  prAchieved(props: BaseProps & { exercise: string; metric: 'e1rm' | 'volume' | 'rep_max'; value: number }): void {
    void _track('pr_achieved', { exercise: props.exercise, metric: props.metric, value: props.value }, props.token);
  },

  // ── AI coach ─────────────────────────────────────────────────────────────
  coachCheckinSubmit(props: BaseProps & { kind: 'micro' | 'weekly' }): void {
    void _track('coach_checkin_submit', { kind: props.kind }, props.token);
  },
  coachActionApply(props: BaseProps & { action: string }): void {
    void _track('coach_action_apply', { action: props.action }, props.token);
  },
  coachActionUndo(props: BaseProps & { action: string }): void {
    void _track('coach_action_undo', { action: props.action }, props.token);
  },

  // ── Monetization ─────────────────────────────────────────────────────────
  paywallView(props: BaseProps & { source: string }): void {
    void _track('paywall_view', { source: props.source }, props.token);
  },
  proUpgradeStart(props: BaseProps & { source: string; sku?: string }): void {
    void _track('pro_upgrade_start', { source: props.source, sku: props.sku }, props.token);
  },
  proUpgradeComplete(props: BaseProps & { source: string; sku?: string }): void {
    void _track('pro_upgrade_complete', { source: props.source, sku: props.sku }, props.token);
  },
  trialStart(props: BaseProps & { days: number }): void {
    void _track('trial_start', { days: props.days }, props.token);
  },
  trialExpired(props: BaseProps = {}): void {
    void _track('trial_expired', {}, props.token);
  },

  // ── Social ───────────────────────────────────────────────────────────────
  friendAdded(props: BaseProps & { via: 'share_code' | 'username' | 'contact' }): void {
    void _track('friend_added', { via: props.via }, props.token);
  },
  workoutShared(props: BaseProps & { workout_id?: number }): void {
    void _track('workout_shared', { workout_id: props.workout_id }, props.token);
  },
  templateShared(props: BaseProps & { template_id: string | number; share_code: string }): void {
    void _track('template_shared', { template_id: props.template_id, share_code: props.share_code }, props.token);
  },
  templateImported(props: BaseProps & { share_code: string }): void {
    void _track('template_imported', { share_code: props.share_code }, props.token);
  },

  // ── Wearables / imports ──────────────────────────────────────────────────
  wearableConnected(props: BaseProps & { provider: string }): void {
    void _track('wearable_connected', { provider: props.provider }, props.token);
  },
  importStarted(props: BaseProps & { source: string }): void {
    void _track('import_started', { source: props.source }, props.token);
  },
  importCompleted(props: BaseProps & { source: string; rows: number; errors: number }): void {
    void _track('import_completed', { source: props.source, rows: props.rows, errors: props.errors }, props.token);
  },

  // ── Error funnel (non-fatal) ────────────────────────────────────────────
  /** Use sparingly — a "user tried to do X, it failed, but we recovered"
   *  signal. For actual crashes call `captureException` directly. */
  featureError(props: BaseProps & { feature: string; reason: string }): void {
    void _track('feature_error', { feature: props.feature, reason: props.reason }, props.token);
  },
};

export default analytics;
