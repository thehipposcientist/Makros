# Apple Health / HealthKit — Architecture

Last synced from app state: 2026-05-31

## HealthDataSummary Aggregator (`src/services/healthDataSummary.ts`)

Single source of truth for Apple Health reads and backend health-snapshot pushes in the client. Shared readiness/permissions callers should go through `src/services/platformHealth.ts` so Android can attach Health Connect without duplicating screens.

Android note: the equivalent integration is Health Connect. Keep Android work in a separate platform-health path; see `docs/architecture/android-health-connect.md`.

**API:**
- `getCachedHealthDataSummary()` — instant first paint from cache.
- `refreshHealthDataSummary()` — force fresh read.
- `getHealthDataSummary({age})` — cached with stale-refresh.

**Flat shape:**
`steps`, `sleepMinutes`, `restingHeartRate`, `hrv`, `workoutMinutes`, `cardioMinutes`, `zone2Minutes`, `activeEnergyKcal`, `weightLbs`, `vo2Max`, plus `weekly` rollup and `raw` for legacy callers. Dietary calories/protein/carbs/fat are read through `readDailyNutritionSnapshot()` rather than the main summary because they are a per-day external nutrition snapshot, not a vitals rollup.

`readDailySnapshot()` also captures server-persisted wearable context used by longer-window health signals: respiratory rate, oxygen saturation, sleeping wrist temperature, and Apple sleeping breathing disturbances when the iOS SDK/device exposes them. These are optional; missing values lower confidence instead of blocking the whole signal.

**Behavior:**
- 30-min stale window, in-flight dedup.
- `null` = unknown / `0` = known-zero.
- Cardio minutes and Z2 minutes only come from cardio-classified workouts. HR-zone exposure during strength, mobility, yoga, and other non-cardio workouts does not count toward cardio totals. Mixed strength + cardio labels count only an estimated finisher block, not the full session.
- Z2: prefer real HR zone samples for cardio-classified workouts when present; fallback treats steady cardio >=20 min as Z2 when HR-zone data is unavailable.
- Nutrition: Apple Health dietary energy/protein/carbs/fat are permissioned read types. MyFitnessPal and similar apps can write meal summaries into Apple Health; Thallo reads only the daily totals, not individual food rows.

## Backend Persistence

- Daily HealthKit rollups are stored in `daily_health_snapshots` through `POST /health/snapshot` and `POST /health/snapshot/batch`; `GET /health/history` powers visible history and server-side trend logic. Every `healthDataSummary` refresh pushes today + yesterday.
- Daily Stress timeline summaries are stored in `daily_stress_summaries` through `POST /health/stress-summary`; `GET /health/stress-history` returns daily average history plus a prior-day personal baseline so the UI can say whether today is above, below, or about the user's usual. This is recovery context only and never mutates the active `PlanWeek`.
- Optional lab markers are stored separately in `health_lab_results` through `GET/POST/DELETE /health/labs`. This includes bloodwork plus reviewed DXA/BMD markers (`bone_mineral_density`, `bone_density_t_score`, `bone_density_z_score`) for bone-density insight context. Lab report scanning uses `POST /ai/scan-labs` only to extract candidate rows; the client must show a review step and save confirmed markers through `/health/labs`. Raw reports are not persisted.
- `GET /health/metabolic-signals?days=14|30` returns deterministic lifestyle-support estimates for hormone support, stress/cortisol rhythm, and cellular-cleanup opportunity. It uses persisted nutrition, activity, sleep, vitals, demographics, timing context, and optional labs over the requested window. Output is intentionally qualitative (`high` / `moderate` / `low` / `elevated` / `not_enough_data`) with confidence, drivers, missing data, and a non-diagnostic disclaimer. It does not estimate serum hormone concentrations or directly measure autophagy. The stress rhythm is daypart-based: wake/morning support, daytime load, and evening downshift risk.
- **Permission-grant backfill is 180 days (2026-05-10).** `backfillSnapshotsToBackend(days=180)` runs once after onboarding's Connect Apple Health success and once after the Progress-tab connect flow. The client chunks the read+push into two 90-day batches (the backend `/health/snapshot/batch` endpoint caps at 90 rows per transaction). The recent 90 days push first so body-check / readiness / weekly-review surfaces populate immediately; the older 90 days push in the background. Per-chunk failures don't abort the rest. Safe to call repeatedly — both endpoints are idempotent upserts. Effective ceiling is `BACKFILL_MAX_DAYS = 365` in `healthDataSummary.ts`.
- **Catch-up backfill for existing users (2026-05-10).** `ensureBackfillWindow(180)` fires as a fire-and-forget side effect of `refreshHealthDataSummary` (which runs on Home open). It reads an AsyncStorage status (`healthBackfillStatus_v1` = `{completedDays, lastAttemptMs}`) and runs the missing span only when `completedDays < 180`. Cooldown of 24 h between attempts so a user with no HK history (or an offline session) doesn't busy-loop. `completedDays` advances only when at least one row was actually pushed — so a totally-failed network attempt stays retry-eligible on next session. When the window grows again (e.g. 180 → 365), just change the constant in two places (`OnboardingScreen`, `ProgressScreen`) plus the `ensureBackfillWindow` argument and existing users auto-migrate.
- Per-night sleep rows are stored in `sleep_logs` through `POST /sleep/nightly` and `POST /sleep/nightly/batch`; `GET /sleep/history` powers sleep baselines and the Health tab history card. App startup imports `app/_layout.tsx` so nightly sleep persistence can run even before Progress opens.
- Morning sleep readiness notifications are opt-in from Settings -> Reminders. `refreshHealthDataSummary()` fires a local notification once per local date during the 5am-11am window when Apple Health is available, a real `sleepScore` exists, notification permission is already granted, and quiet hours are not active. The notification best-effort enriches copy from canonical `/readiness/today`; if auth or network is unavailable, it falls back to sleep-score recovery copy. The notification is recovery context only and never mutates the active `PlanWeek`.
- `GET /sleep/pressure` returns a deterministic rolling sleep-gap signal over the last 14 days. It compares recent sleep against a conservative personal sleep-need estimate, gives limited credit for catch-up nights, caps the displayed gap at 8h+, and feeds readiness as a small sleep-pillar adjustment. This is recovery context, not a literal debt ledger and never mutates the active `PlanWeek`.
- Both upsert paths are patch-style: later partial rows fill gaps without erasing earlier values.
- `DailyHealthSnapshot.source_details` carries optional provider and per-field provenance, e.g. Apple Health for steps and Oura for HRV on the same date.

**Migration status:** `healthDataSummary` is the shared cache and backend-push path. The main readiness and health-permission surfaces now use `platformHealth.ts`; direct `appleHealth` imports remain for iOS-only workout write/import details and a few feature-specific readers.

## HK Write (workouts)

`modules/thallo-healthkit/ios/...::saveWorkout` AsyncFunction wraps `HKWorkoutBuilder`. When `routeCoords` are supplied, the module writes them through `HKWorkoutRouteBuilder` so outdoor-cardio sessions can appear with a route in Apple Fitness. Called for:
- Completed lift sessions (phone-side).
- Live-tracker sessions, including outdoor-cardio distance/pace/route when captured.
- Log-activity sessions.

Watch-started sessions use `targets/thallo-watch/HeartRateStore.swift` with `HKWorkoutSession` + `HKLiveWorkoutBuilder`: normal end calls `finishWorkout`, while cancel/discard calls `discardWorkout` so cancelled sessions do not land in Apple Health.

## Privacy / Review Notes

- HealthKit is optional and must stay framed as optional in onboarding, Settings, and Progress.
- App and Watch usage strings disclose read categories, workout writes, energy/distance writes, and route writes when present.
- HealthKit data must not be used for advertising, third-party ad tracking, or social sharing.
- Raw HealthKit samples should remain on device; backend persistence is daily/nightly summaries or user-saved workout/import records.

## Detected Workout Import

`DetectedWorkoutsCard` / `workoutAutoImport.ts` can turn Apple Health workouts into local Thallo workout sessions. Imported workouts then sync through the normal workout-completion paths so fatigue, progress, and history can react to wearable/manual activity that was not started inside Thallo.

## Live Activity Detection

`modules/thallo-healthkit/ios/...::startActivityDetection` uses Core Motion `CMMotionActivityManager` to detect sustained walking, running, or cycling while the app is active. The feature is opt-in through Settings -> Plan -> Activity Detection and is stored as a local device preference (`activityDetectionEnabled_v1`). `src/services/activityDetection.ts` normalizes native events and `DetectedActivityPrompt` asks the user to either start tracking or log the activity. Confirmed activities route through the existing live-tracker / `LogActivityModal` / workout-completion paths; detection never mutates the active `PlanWeek` directly.

## Cycle Phase

`getCycleStatus` reads Apple Health menstrual-flow samples and returns `{phase, dayOfCycle, cycleLengthDays, nextExpectedMenses, currentFlow}`. The signal is transient and permission-aware: no raw menstrual-flow table is persisted.

Current consumers:
- `CyclePhaseCard` and `PeriodSupportCard` display cycle-aware guidance.
- `POST /readiness/today` accepts `cycle_phase` / `day_of_cycle`; server readiness adds the optional cycle pillar when present.
- `POST /plans/start-new-week` and `POST /plans/week/auto-renew` can pass cycle context into `planner_context`; `planner.py` softly adjusts muscle-volume targets by phase (`menses` / `luteal` lower, `follicular` / `ovulation` slightly higher).
