# Apple Health / HealthKit — Architecture

Last synced from app state: 2026-05-07

## HealthDataSummary Aggregator (`src/services/healthDataSummary.ts`)

Single source of truth for all Apple Health reads in the client.

Android note: the equivalent integration is Health Connect. Keep Android work in a separate platform-health path; see `docs/architecture/android-health-connect.md`.

**API:**
- `getCachedHealthDataSummary()` — instant first paint from cache.
- `refreshHealthDataSummary()` — force fresh read.
- `getHealthDataSummary({age})` — cached with stale-refresh.

**Flat shape:**
`steps`, `sleepMinutes`, `restingHeartRate`, `hrv`, `workoutMinutes`, `cardioMinutes`, `zone2Minutes`, `activeEnergyKcal`, `weightLbs`, `vo2Max`, plus `weekly` rollup and `raw` for legacy callers.

**Behavior:**
- 30-min stale window, in-flight dedup.
- `null` = unknown / `0` = known-zero.
- Z2: prefer real HR zone samples when present; fallback treats steady cardio ≥20 min as Z2 when HR-zone data is unavailable.

## Backend Persistence

- Daily HealthKit rollups are stored in `daily_health_snapshots` through `POST /health/snapshot` and `POST /health/snapshot/batch`; `GET /health/history` powers visible history and server-side trend logic. Every `healthDataSummary` refresh pushes today + yesterday, and permission grant can backfill up to 30 days.
- Per-night sleep rows are stored in `sleep_logs` through `POST /sleep/nightly` and `POST /sleep/nightly/batch`; `GET /sleep/history` powers sleep baselines and the Health tab history card. App startup imports `app/_layout.tsx` so nightly sleep persistence can run even before Progress opens.
- Both upsert paths are patch-style: later partial rows fill gaps without erasing earlier values.

**Migration status:** `healthDataSummary` is the shared cache and backend-push path. Some UI surfaces still call `readHealthSummary` directly for fresh one-off reads or `raw` details, but readiness/watch payloads converge through the server `/readiness/today` flow.

## HK Write (workouts)

`modules/thallo-healthkit/ios/...::saveWorkout` AsyncFunction wraps `HKWorkoutBuilder`. Called for:
- Completed lift sessions (phone-side).
- Live-tracker sessions.
- Log-activity sessions.

Watch-started sessions use `targets/thallo-watch/HeartRateStore.swift` with `HKWorkoutSession` + `HKLiveWorkoutBuilder`: normal end calls `finishWorkout`, while cancel/discard calls `discardWorkout` so cancelled sessions do not land in Apple Health.

## Detected Workout Import

`DetectedWorkoutsCard` / `workoutAutoImport.ts` can turn Apple Health workouts into local Thallo workout sessions. Imported workouts then sync through the normal workout-completion paths so fatigue, progress, and history can react to wearable/manual activity that was not started inside Thallo.

## Cycle Phase

`getCycleStatus` reads Apple Health menstrual-flow samples and returns `{phase, dayOfCycle, cycleLengthDays, nextExpectedMenses, currentFlow}`. The signal is transient and permission-aware: no raw menstrual-flow table is persisted.

Current consumers:
- `CyclePhaseCard` and `PeriodSupportCard` display cycle-aware guidance.
- `POST /readiness/today` accepts `cycle_phase` / `day_of_cycle`; server readiness adds the optional cycle pillar when present.
- `POST /plans/start-new-week` and `POST /plans/week/auto-renew` can pass cycle context into `planner_context`; `planner.py` softly adjusts muscle-volume targets by phase (`menses` / `luteal` lower, `follicular` / `ovulation` slightly higher).
