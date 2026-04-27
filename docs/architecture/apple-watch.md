# Apple Watch — Architecture

Last synced from CLAUDE.md: 2026-04-27

## Bidirectional Sync via WCSession

- **Bridge**: `modules/thallo-watch-bridge/` (phone) ↔ `targets/thallo-watch/ConnectivityStore.swift` (watch).

**Outbound (phone → watch):**
`pushWorkoutToWatch`, `pushMealsToWatch`, `pushSupplementsToWatch`, `pushThemeToWatch`, `pushProgressToWatch` (per-set updates). All routed through `applicationContext` with fallback to `transferUserInfo` on duplicate-payload errors.

**Inbound (watch → phone):**
`start_workout`, `skip_workout`, `cancel_workout`, `end_workout`, `log_set`, `toggle_meal`, `toggle_supplement`, `take_all_supplements`, `pull_state`.

**Pull-on-wake handshake:**
Watch fires `pull_state` on `WCSession.activate` + `sessionReachabilityDidChange(reachable=true)` + SwiftUI `scenePhase == .active`. Phone responds with fresh full snapshot.

**Key implementation decisions:**
- `isPaired` silent gate **REMOVED** — it dropped payloads during transient unpaired states. Now only `isAvailable()` (platform support) gates pushes.
- `clearWatchData()` on sign-out pushes empty workout/meals/supplements payloads (user-switch wipe).

## Watch App Pages

TabView: **Today** (workout) / **Meals** / **Supps**. Page dots always visible.

**Active workout**: Digital Crown + −/+ steppers, rest timer, HR persistent chip, swipe-right HR zones tab, warm-up card before first set, end + cancel + skip-exercise menu.

**Phone-side HK write**: `saveWorkoutToHealth` via `modules/thallo-healthkit/ios/...::saveWorkout` wraps `HKWorkoutBuilder`. Watch-started sessions write via `HKLiveWorkoutBuilder.finishWorkout` from watch target.

## Active-State Persistence (#148) — IMPLEMENTED

`targets/thallo-watch/ActiveWorkoutView.swift::ActiveWorkoutState` persists `exerciseIndex` / `setNumber` / `restRemaining` / `paused` / `pendingWeight` / `pendingReps` / `lastLoggedWeight` / `lastLoggedReps` to UserDefaults via `didSet` on every `@Published`.

- `hydrate()` runs in `init` — backgrounded watch app re-mounts to exact state.
- `clearPersisted()` called on workout end/cancel.
- Hydrate guard (`hydrating = true`) prevents restore from re-triggering `persist()`.

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
