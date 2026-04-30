# Apple Watch — Architecture

Last synced from app state: 2026-04-30

## Bidirectional Sync via WCSession

- **Bridge**: `modules/thallo-watch-bridge/` (phone) ↔ `targets/thallo-watch/ConnectivityStore.swift` (watch).

**Outbound (phone → watch):**
`pushWorkoutToWatch`, `pushMealsToWatch`, `pushSupplementsToWatch`, `pushThemeToWatch`, `pushProgressToWatch` (per-set updates). `pushProgressToWatch` now carries both rest-timer deltas and the latest live recommendation text so the watch can refresh next-set guidance during rest. Full snapshots are dual-path: they update `applicationContext` for cold-start persistence and, when reachable, also send an immediate `sendMessage` mirror. `sendMessage` failures fall back to `transferUserInfo`.

Workout snapshots use a v2 envelope:
`{ schemaVersion: 2, channel: "workout", eventId, revision, reason, sentAtMs, userId, workout }`.
The bridge stores it under `workoutEnvelope` and also writes a legacy top-level `workout` copy for older watch builds. The watch prefers `workoutEnvelope`, orders by monotonic `revision`, rejects mismatched `userId`, and only falls back to legacy `workout` when no valid envelope is present.

**Inbound (watch → phone):**
`start_workout`, `skip_workout`, `cancel_workout`, `end_workout`, `log_set`, `toggle_meal`, `toggle_supplement`, `take_all_supplements`, `pull_state`.

Watch commands carry a `commandId`; the phone bridge de-dupes recent IDs so `sendMessage` fallback to `transferUserInfo` cannot double-apply a set log or end command.

**Pull-on-wake handshake:**
Watch fires `pull_state` on `WCSession.activate` + `sessionReachabilityDidChange(reachable=true)` + SwiftUI `scenePhase == .active`. Phone responds with fresh full snapshot.

**Key implementation decisions:**
- `isPaired` silent gate **REMOVED** — it dropped payloads during transient unpaired states. Now only `isAvailable()` (platform support) gates pushes.
- `clearWatchData()` on sign-out pushes empty workout/meals/supplements payloads (user-switch wipe).
- Workout clear is an explicit envelope `reason: "clear"` so stale completed/active payloads cannot rehydrate after logout or account switch.

## Watch App Pages

TabView: **Today** (workout) / **Meals** / **Supps**. Page dots always visible.

**Active workout**: Digital Crown + −/+ steppers, rest timer, HR persistent chip, live recommendation text, swipe-right HR zones tab, warm-up card before first set, end + cancel + skip-exercise menu.

**Phone-side HK write**: `saveWorkoutToHealth` via `modules/thallo-healthkit/ios/...::saveWorkout` wraps `HKWorkoutBuilder`. Watch-started sessions write via `HKLiveWorkoutBuilder.finishWorkout` from watch target.

## Active-State Persistence (#148) — IMPLEMENTED

`targets/thallo-watch/ActiveWorkoutView.swift::ActiveWorkoutState` persists `exerciseIndex` / `setNumber` / `restRemaining` / `paused` / `pendingWeight` / `pendingReps` / `lastLoggedWeight` / `lastLoggedReps` / `currentRecommendation` to UserDefaults via `didSet` on every `@Published`.

- `hydrate()` runs in `init` — backgrounded watch app re-mounts to exact state.
- `clearPersisted()` called on workout end/cancel.
- Hydrate guard (`hydrating = true`) prevents restore from re-triggering `persist()`.
- Recommendation hydration uses `state.currentRecommendation ?? ex.recommendation`, so the watch prefers fresh phone-pushed guidance during a live rest window and falls back to the static exercise recommendation when no live override exists.

## Watch Complication Scaffold (#110 — NOT YET SHIPPED)

`targets/thallo-watch-complication/` — `@bacons/apple-targets` widget config + SwiftUI complication source. Surfaces today's focus + readiness (accessoryCircular / Rectangular / Inline). Reads payload from SharedDefaults `group.com.thallo.app`.

**Blocked until:**
1. `expo prebuild` generates the target.
2. App Group entitlement matches across both watch targets.
3. Main watch app calls `WidgetCenter.shared.reloadAllTimelines()` after writing SharedDefaults.

## Siri Intent Scaffold (#111 — NOT YET SHIPPED)

`ios-extras/StartWorkoutAppIntent.swift` — stub `AppIntent` opening `thallo://start-workout`. File body is `#if false`.

**Blocked until:** Intents extension target added in Xcode + matching deep-link handler in `app/_layout.tsx`.

## Payload Change Rules

When changing WCSession payloads:
1. Update `modules/thallo-watch-bridge/` (phone side).
2. Update `targets/thallo-watch/ConnectivityStore.swift` + any Swift structs that decode the payload.
3. Both sides must agree on field names — Swift `Codable` will silently ignore extra fields but fail on type mismatches.
