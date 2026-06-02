# Android Health Connect Architecture

Last updated: 2026-05-24

## Decision

Android's Apple Health equivalent is **Health Connect**.

For the first Android beta, Thallo ships without Health Connect reads/writes. Android users still get onboarding, deterministic plans, workouts, meals, hydration, weight, supplements, scans, coach features, recovery check-ins, and backend sync through the shared React Native app.

Health Connect should be implemented as the Android peer to `src/services/appleHealth.ts`, not by weakening the Apple Health service. `src/services/platformHealth.ts` now exists as the platform abstraction: iOS routes to Apple Health, Android returns Health Connect no-op/manual-mode results until the native reader is built.

Official docs:
- Health Connect overview: https://developer.android.com/health-and-fitness/health-connect
- Health Connect get started: https://developer.android.com/health-and-fitness/health-connect/get-started
- Health Connect availability: https://developer.android.com/health-and-fitness/health-connect/availability

## Platform Notes

- Android 14+ includes Health Connect as part of the Android framework.
- Android 13 and lower require the Health Connect app from Google Play.
- Health Connect data access is sensitive. Requested data types must be declared in the Android manifest and in Play Console.
- Users can revoke permissions at any time, so every read/write path must re-check granted permissions.
- Health Connect can read up to 30 days of records before permission grant by default. Longer history requires the history permission.

## Thallo Data Mapping

Read candidates:
- Steps -> `DailyHealthSnapshot.steps`
- Active calories -> `DailyHealthSnapshot.active_energy_kcal`
- Exercise sessions -> workout/cardio minutes and import candidates
- Heart rate -> workout HR summaries and readiness context
- Resting heart rate -> `DailyHealthSnapshot.resting_hr`
- HRV -> `DailyHealthSnapshot.hrv_ms`
- Sleep sessions/stages -> `sleep_logs` and sleep score inputs
- Weight -> weight trend and optional weight snapshot
- VO2 max, respiratory rate, oxygen saturation -> optional recovery context
- Menstruation/cycle records -> cycle-aware guidance, if available and permitted

Write candidates:
- Completed Thallo workouts
- Workout active energy and distance when a session has those values
- Optional body weight writes should remain opt-in and clearly disclosed

## Implementation Plan

1. Add a native Expo module, likely `modules/thallo-health-connect`, with Android-only Kotlin bindings.
2. Add `src/services/androidHealthConnect.ts` with the same high-level functions exposed by `platformHealth.ts`: availability, permissions, daily summary, daily snapshot, nutrition snapshot, sleep history, cycle status, workout import candidates, latest HR, workout HR/calorie lookup, and workout write.
3. Wire `platformHealth.ts` Android branches to `androidHealthConnect.ts`.
4. Continue migrating any remaining direct `appleHealth` imports that are not inherently iOS-only write/import flows.
5. Add Android manifest permissions only for the first supported data slice. Start narrow: steps, sleep, HR, resting HR, HRV, exercise sessions, active calories, and weight.
6. Add Play Console Health Connect data declarations and a permissions rationale screen before public/closed testing.
7. Keep DB invariants unchanged: daily health snapshots remain server-side summaries; raw device samples stay on device. Include `source="health_connect"` and per-field `source_details` so future direct Oura/WHOOP/Garmin rows can coexist without erasing provenance.

## Non-Goals For First Android Beta

- Wear OS companion app parity with Apple Watch.
- Live Activities parity. Android rest timer should use local notifications first.
- Automatic Health Connect imports before user education and permission review are complete.
