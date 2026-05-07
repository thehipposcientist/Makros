# Android Health Connect Architecture

Last updated: 2026-05-07

## Decision

Android's Apple Health equivalent is **Health Connect**.

For the first Android beta, Thallo ships without Health Connect reads/writes. Android users still get onboarding, deterministic plans, workouts, meals, hydration, weight, supplements, scans, coach features, recovery check-ins, and backend sync through the shared React Native app.

Health Connect should be implemented as the Android peer to `src/services/appleHealth.ts`, not by weakening the Apple Health service. Keep Apple Health and Health Connect behind a platform health abstraction so screens ask for "health summary" data instead of directly coupling to one platform.

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
2. Add `src/services/androidHealthConnect.ts` with the same high-level functions the app currently expects from Apple Health: availability, permissions, daily summary, sleep history, workout import candidates, latest HR, workout HR/calorie lookup, and workout write.
3. Add `src/services/platformHealth.ts` to route iOS to Apple Health, Android to Health Connect, and unsupported platforms to no-op/manual mode.
4. Migrate UI callers from `appleHealth` imports to the platform abstraction file-by-file.
5. Add Android manifest permissions only for the first supported data slice. Start narrow: steps, sleep, HR, resting HR, HRV, exercise sessions, active calories, and weight.
6. Add Play Console Health Connect data declarations and a permissions rationale screen before public/closed testing.
7. Keep DB invariants unchanged: daily health snapshots remain server-side summaries; raw device samples stay on device.

## Non-Goals For First Android Beta

- Wear OS companion app parity with Apple Watch.
- Live Activities parity. Android rest timer should use local notifications first.
- Automatic Health Connect imports before user education and permission review are complete.

