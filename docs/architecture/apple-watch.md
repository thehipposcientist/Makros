# Apple Watch — Architecture

Last synced from app state: 2026-05-05

## Bidirectional Sync via WCSession

- **Bridge**: `modules/thallo-watch-bridge/` (phone) ↔ `targets/thallo-watch/ConnectivityStore.swift` (watch).

**Outbound (phone → watch):**
`pushWorkoutToWatch`, `pushMealsToWatch`, `pushHydrationToWatch`, `pushSupplementsToWatch`, `pushThemeToWatch`, `pushProgressToWatch` (per-set updates). `pushProgressToWatch` carries rest timer state (`restRemainingSec`, `restStartedAtMs`, `restDurationSec`, `restEndsAtMs`) and the latest live recommendation text so the watch can refresh next-set guidance during rest and recompute the countdown from wall clock after screen sleep. Full snapshots are dual-path: they update `applicationContext` for cold-start persistence and, when reachable, also send an immediate `sendMessage` mirror. `sendMessage` failures fall back to `transferUserInfo`.

Workout snapshots use a v2 envelope:
`{ schemaVersion: 2, channel: "workout", eventId, revision, reason, sentAtMs, userId, workout }`.
The bridge stores it under `workoutEnvelope` and also writes a legacy top-level `workout` copy for older watch builds. The watch prefers `workoutEnvelope`, orders by monotonic `revision`, rejects mismatched `userId`, and only falls back to legacy `workout` when no valid envelope is present.

Active workout exercise rows can include `plannedTargetWeightLbs` and up to five phone-ranked `swapOptions`. The phone ranks swaps with the same library scorer used by the in-workout picker, so substitutions stay in the same archetype/slot while the watch keeps the original placement, sets, reps, and rest prescription.

**Inbound (watch → phone):**
`start_workout`, `skip_workout`, `cancel_workout`, `end_workout`, `log_set`, `swap_exercise`, `toggle_meal`, `log_hydration`, `toggle_supplement`, `take_all_supplements`, `pull_state`.

`log_set` includes `exerciseIndex`, explicit 1-indexed `setNumber`, weight/reps/duration and, when the watch user overshoots the target rep range, an optional `rir` value captured on-watch before the command is sent. The phone commits the set locally first and runs rest notifications, recommendations, and `/workouts/sync` as follow-up side effects so a slow backend or notification permission path cannot block later watch taps.

Watch commands carry a `commandId`; the phone bridge de-dupes recent IDs so `sendMessage` fallback to `transferUserInfo` cannot double-apply a set log or end command.

When the native phone bridge receives a mutating watch command before JS listeners are attached, it stores the command in a durable `UserDefaults` queue (bounded + TTL-filtered). Home drains general commands on mount. During the Home -> ActiveWorkout handoff, `ActiveWorkoutScreen` marks the active command consumer ready only after its listener is attached; until then Home mirrors `log_set` commands into `activeWorkoutSets` and stashes non-log active commands in a small AsyncStorage backlog for replay.

If `log_set` arrives while `ActiveWorkoutScreen` is not mounted, Home mirrors it into `activeWorkoutSets`, updates the resume banner, and calls `/workouts/sync` so watch-only sessions are backed up to `WorkoutSession` rows mid-workout. Home does not push a replacement workout snapshot while a workout is active; progress and active snapshots remain owned by `ActiveWorkoutScreen` or the watch's local state to avoid resetting the watch session.

Rest timers are synced as live progress with an absolute `restEndsAtMs`. The native bridge preserves the newest `progress` payload when unrelated context updates (theme, meals, hydration, supplements) merge into `applicationContext`, and `ActiveWorkoutScreen` reasserts rest progress after watch wake/pull so a stale context cannot clear an active rest timer.

**Pull-on-wake handshake:**
Watch fires `pull_state` on `WCSession.activate` + `sessionReachabilityDidChange(reachable=true)` + SwiftUI `scenePhase == .active`. Phone responds with fresh full snapshot.
If a phone rest timer is currently active, the phone also sends a fresh `pushProgressToWatch` after the snapshot so the watch receives an absolute `restEndsAtMs` even when it joins mid-rest.

**Phone-start behavior:** phone Start pre-stamps `activeWatchSessionId` / `activeWorkoutStartTime`, pushes an `active_snapshot` immediately, then calls the native bridge's `HKHealthStore.startWatchApp(with:)` path. The watch app handles that launch via `WKApplicationDelegate.handle(_:)`, requests a pull, and opens `ActiveWorkoutView` as soon as the active snapshot arrives. If watchOS declines the launch or reachability does not come up shortly after, the phone shows a nudge telling the user to open Thallo on the watch; the workout is already queued, so no second Start tap should be needed.

**Key implementation decisions:**
- `isPaired` silent gate **REMOVED** — it dropped payloads during transient unpaired states. Now only `isAvailable()` (platform support) gates pushes.
- `clearWatchData()` on sign-out pushes empty workout/meals/supplements payloads (user-switch wipe).
- Workout clear is an explicit envelope `reason: "clear"` so stale completed/active payloads cannot rehydrate after logout or account switch.

## Watch App Pages

TabView: **Today** (workout) / **Meals** / **Hydration** / **Supps** / **Sleep** / **Readiness** / **Quick Start** / **Weight**. Page dots always visible.

**Hydration**: quick-add 8 / 16 / 24 oz buttons, -8 oz correction, and a Digital Crown total setter. Watch quick-add/correction sends `log_hydration` deltas so queued taps compose after the phone wakes; Digital Crown set sends an absolute ounce total. Phone persists through `POST /meals/hydration` and re-pushes the server-computed target.

**Active workout**: Digital Crown + −/+ steppers, recommended-weight quick-use row, rest timer, HR persistent chip, live recommendation text, swipe-right HR zones tab, warm-up card before first set, end + cancel + skip/swap-exercise menu.

**Start behavior**: watch Start is local-first. It immediately mints a local `sessionId`, presents `ActiveWorkoutView`, clears stale watch set state, and sends `start_workout` with that `sessionId` to the phone in the background. The phone reuses the watch-provided id for its active echo, so sets logged before the echo lands still belong to the same workout session. The phone still owns persistence, but the watch no longer waits on the phone echo or on a HealthKit workout session before tracking sets.

**HealthKit**: watch tracking does not save a HealthKit workout. Heart-rate/runtime support may start opportunistically, but end/cancel discards the builder so workout history remains Thallo-authoritative.

## Active-State Persistence (#148) — IMPLEMENTED

`targets/thallo-watch/ActiveWorkoutView.swift::ActiveWorkoutState` persists `exerciseIndex` / `setNumber` / `restRemaining` / `restEndAtMs` / `sessionId` / `paused` / `pendingWeight` / `pendingReps` / `lastLoggedWeight` / `lastLoggedReps` / `currentRecommendation` to UserDefaults via `didSet` on every `@Published`.

- `hydrate()` runs in `init` — backgrounded watch app re-mounts to exact state.
- `clearPersisted()` called on workout end/cancel.
- Hydrate guard (`hydrating = true`) prevents restore from re-triggering `persist()`.
- `attach(to:)` binds persisted state to the current workout `sessionId`; a new workout session resets stale set/rest state so prior sessions cannot show impossible counts like `4 of 3`.
- Rest countdowns persist as absolute end timestamps and are reconciled on timer ticks and SwiftUI `scenePhase == .active`, so watchOS sleep/wake does not freeze the timer.
- Recommendation hydration uses `state.currentRecommendation ?? ex.recommendation`, so the watch prefers fresh phone-pushed guidance during a live rest window and falls back to the static exercise recommendation when no live override exists.

## Watch Complication + Smart Stack (#110 — IMPLEMENTED)

`targets/thallo-watch-complication/` — watchOS WidgetKit extension embedded in `ThalloWatch.app`. Ships separate static complication choices for Daily Summary, Workout, Readiness, Sleep, and Water across accessoryCircular / accessoryRectangular / accessoryInline. The existing `ThalloWatchComplication` kind remains the Daily Summary option so installed watch faces keep working after updates.

**Data path:** `targets/thallo-watch/ConnectivityStore.swift` mirrors the latest workout / hydration / readiness / sleep snapshot into SharedDefaults `group.com.thallo.app` via `ThalloComplicationSync`, then calls `WidgetCenter.shared.reloadAllTimelines()`.

**Actions:** widget links open the watch app through the `thallowatch://` URL scheme. `thallowatch://start-workout` starts or rejoins today's workout through the existing watch `start_workout` command path. Hydration widget links open the Hydration page only; water is logged only from explicit controls inside the watch or phone app. Phone/backend remain authoritative.

**Signing requirement:** the App Group `group.com.thallo.app` must be enabled for both `com.thallo.app.watch` and `com.thallo.app.watch.widget` in Apple Developer before device/TestFlight signing.

## Siri Intent Scaffold (#111 — NOT YET SHIPPED)

`ios-extras/StartWorkoutAppIntent.swift` — stub `AppIntent` opening `thallo://start-workout`. File body is `#if false`.

**Blocked until:** Intents extension target added in Xcode + matching deep-link handler in `app/_layout.tsx`.

## Payload Change Rules

When changing WCSession payloads:
1. Update `modules/thallo-watch-bridge/` (phone side).
2. Update `targets/thallo-watch/ConnectivityStore.swift` + any Swift structs that decode the payload.
3. Both sides must agree on field names — Swift `Codable` will silently ignore extra fields but fail on type mismatches.
