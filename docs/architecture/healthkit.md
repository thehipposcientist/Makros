# Apple Health / HealthKit — Architecture

Last synced from CLAUDE.md: 2026-04-27

## HealthDataSummary Aggregator (`src/services/healthDataSummary.ts`)

Single source of truth for all Apple Health reads in the client.

**API:**
- `getCachedHealthDataSummary()` — instant first paint from cache.
- `refreshHealthDataSummary()` — force fresh read.
- `getHealthDataSummary({age})` — cached with stale-refresh.

**Flat shape:**
`steps`, `sleepMinutes`, `restingHeartRate`, `hrv`, `workoutMinutes`, `cardioMinutes`, `zone2Minutes`, `activeEnergyKcal`, `weightLbs`, `vo2Max`, plus `weekly` rollup.

**Behavior:**
- 30-min stale window, in-flight dedup.
- `null` = unknown / `0` = known-zero.
- Z2: prefer real HR zone samples when present; fallback treats steady cardio ≥20 min as Z2 when HR-zone data is unavailable.

**Migration status:** ProgressScreen migrated to `getHealthDataSummary`. Remaining direct `readHealthSummary` callers (HomeScreen, ActiveWorkoutScreen) can migrate file-by-file — the aggregator wraps the same fn so callers keep working.

## HK Write (workouts)

`modules/thallo-healthkit/ios/...::saveWorkout` AsyncFunction wraps `HKWorkoutBuilder`. Called for:
- Completed lift sessions (phone-side).
- Live-tracker sessions.
- Log-activity sessions.

Watch-started sessions write via `HKLiveWorkoutBuilder.finishWorkout` from the watch target.

## In-App Dev Logs (#128)

Not strictly HealthKit but a debugging tool:
- `src/utils/devLogs.ts` — ring-buffer of last 400 log entries.
- `src/components/DevLogsViewer.tsx` — modal with filter + level + iOS share sheet.
- Trigger: Account modal → "Developer logs" link.
- Critical for TestFlight builds where Metro/Xcode console are inaccessible.

## Cycle-Phase (Future — not yet wired to planner)

`CyclePhaseCard` + `getCycleStatus` read Apple Health menstrual data and display phase/tip. The backend planner does not yet receive cycle phase — volume auto-adjustment (reduce 10-15% in luteal, push intensity in follicular/ovulation) is a planned enhancement via `healthDataSummary` → `readiness` → `fatigue` multiplier.
