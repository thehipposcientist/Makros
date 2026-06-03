# Apple Watch — Architecture

Last synced from app state: 2026-06-02

## Bidirectional Sync via WCSession

- **Bridge**: `modules/thallo-watch-bridge/` (phone) ↔ `targets/thallo-watch/ConnectivityStore.swift` (watch).

**Outbound (phone → watch):**
`pushWorkoutToWatch`, `pushMealsToWatch`, `pushHydrationToWatch`, `pushActivityToWatch`, `pushLifestyleToWatch`, `pushSupplementsToWatch`, `pushThemeToWatch`, `pushProgressToWatch` (per-set updates). `pushProgressToWatch` carries rest timer state (`restRemainingSec`, `restStartedAtMs`, `restDurationSec`, `restEndsAtMs`), phone-selected active exercise updates (`progressKind: "active_exercise"` / `allowExerciseBacktrack`), and the latest live recommendation text plus recommended weight/reps so the watch can refresh next-set guidance during rest and recompute the countdown from wall clock after screen sleep. Full snapshots are dual-path: they update `applicationContext` for cold-start persistence and, when reachable, also send an immediate `sendMessage` mirror. `sendMessage` failures fall back to `transferUserInfo`.

Phone-side `applicationContext` writes are serialized in the native bridge and merged from the bridge's last in-memory snapshot before `updateApplicationContext`, so overlapping workout/theme/meals/hydration/activity/sleep/readiness pushes cannot drop keys written by another push.

Workout snapshots use a v2 envelope:
`{ schemaVersion: 2, channel: "workout", eventId, revision, reason, sentAtMs, userId, workout }`.
The bridge stores it under `workoutEnvelope` and also writes a legacy top-level `workout` copy for older watch builds. The watch prefers `workoutEnvelope`, orders by monotonic `revision`, rejects mismatched `userId`, and only falls back to legacy `workout` when no valid envelope is present.

Active workout exercise rows can include `plannedTargetWeightLbs`, `recommendedReps`, `tracksWeight`, `primaryMuscle`, `slotLabel`, `prescriptionType`, `completedSets`, `isDone`, and up to five phone-ranked `swapOptions`. `tracksWeight` is computed on the phone from the same `shouldHideWeight()` predicate used by the active-workout UI, so band/bodyweight/timed/no-load movements stay reps-only on the watch even if stale cached target weights exist. Workout snapshots can also include phone-computed `hrZones` from `/workouts/hr-zones`; the watch uses these same ranges for live HR zone display so the wrist view matches phone recommendations. Progress pushes can include `completedExerciseIndexes` / `exerciseCompletion` so the Today and active plan exercise lists can badge completed rows without requiring a full snapshot after every set. The phone ranks swaps with the same library scorer used by the in-workout picker, so substitutions stay in the same archetype/slot while the watch keeps the original placement, sets, reps, and rest prescription.

**Inbound (watch → phone):**
`start_workout`, `skip_workout`, `cancel_workout`, `end_workout`, `log_set`, `swap_exercise`, `add_exercise`, `add_circuit`, `toggle_meal`, `parse_meal_speech`, `confirm_meal_speech`, `log_hydration`, `log_lifestyle`, `toggle_supplement`, `take_supplement_group`, `take_all_supplements`, `pull_state`.

`log_set` includes `exerciseIndex`, explicit 1-indexed `setNumber`, weight/reps/duration and, when the watch user overshoots the target rep range, an optional `rir` value captured on-watch before the command is sent. The phone commits the set locally first and runs rest notifications, recommendations, and `/workouts/sync` as follow-up side effects so a slow backend or notification permission path cannot block later watch taps.

Watch commands carry a `commandId`; the phone bridge de-dupes recent IDs so `sendMessage` fallback to `transferUserInfo` cannot double-apply a set log or end command.

**Experimental cellular lane:** the iPhone can mint a limited watch token through `POST /auth/watch-token` and push `{ apiBaseUrl, accessToken, expiresAt, userId }` to the watch under the `cellular` channel. The watch stores the token in Keychain and can call the same FastAPI backend with `URLSession` when the phone is unreachable. This is currently additive to WCSession: direct commands supported via `POST /watch/commands` are `log_hydration` and `end_workout`, with `/watch/session` and `/watch/snapshot` available as health-check/snapshot scaffolding. Read-only readiness refresh is available at `GET /watch/readiness`; the watch calls it on wake/manual sync when its cached readiness is stale, then applies the same `computed_at_ms` ordering as phone-pushed readiness. Watch-side set taps still use the phone path while reachable, but the watch now persists logged sets locally and includes them in a cellular `end_workout` completion payload so a finished disconnected session can still create the server `WorkoutCompletion` / `WorkoutSession` / `ExerciseSet` rows. Direct cellular completion is idempotent by watch session id and does not replace the reachable-phone path.

When the native phone bridge receives a mutating watch command before JS listeners are attached, or while the iOS app is inactive/backgrounded and React Native may be suspended, it stores the command in a durable `UserDefaults` queue (bounded + TTL-filtered). Home drains general commands on mount, and the native bridge flushes queued commands to JS when the app becomes active with listeners attached. During the Home -> ActiveWorkout handoff, `ActiveWorkoutScreen` marks the active command consumer ready only after its listener is attached; until then Home mirrors `log_set` commands into `activeWorkoutSets` and stashes non-log active commands in a small AsyncStorage backlog for replay.

If `log_set` arrives while `ActiveWorkoutScreen` is not mounted, Home mirrors it into `activeWorkoutSets`, updates the resume banner, and calls `/workouts/sync` so watch-only sessions are backed up to `WorkoutSession` rows mid-workout. Home does not push replacement full snapshots while a workout is active; progress, rest, and active refreshes remain owned by `ActiveWorkoutScreen` or the watch's local state to avoid resetting the watch session or stalling the phone workout with broad background sync.

Rest timers are synced as live progress with an absolute `restEndsAtMs`. The native bridge preserves the newest `progress` payload when unrelated context updates (theme, meals, hydration, activity, supplements) merge into `applicationContext`, and `ActiveWorkoutScreen` reasserts rest progress after watch wake/pull so a stale context cannot clear an active rest timer.

**Pull-on-wake handshake:**
Watch fires `pull_state` on `WCSession.activate` + `sessionReachabilityDidChange(reachable=true)` + SwiftUI `scenePhase == .active`. Phone responds with fresh full snapshot.
If a phone rest timer is currently active, the phone also sends a fresh `pushProgressToWatch` after the snapshot so the watch receives an absolute `restEndsAtMs` even when it joins mid-rest.
Wake-triggered pulls are cooldown-coalesced on both sides: non-force pulls are dropped while the phone is unreachable, while force wake/manual pulls can travel via `transferUserInfo` as a background nudge; the phone also ignores duplicate non-manual `pull_state` commands that arrive within a few seconds. Manual watch sync buttons send `force=true`, bypassing the cooldown when the user explicitly asks for a refresh.

The native phone bridge also answers every accepted `pull_state` from its cached `applicationContext`/snapshot before handing the command to JS. This keeps the watch responsive when the phone app is backgrounded but still has stale JS listeners registered; if JS is active, it follows with a fresher authoritative snapshot. When the cached readiness snapshot is missing or stale, the watch can also refresh readiness directly through the watch-token lane, using server-persisted health signals and never computing readiness locally. The phone also force-reasserts the full snapshot when the iOS app returns to foreground. This covers the case where the watch app is already open and no reachability transition fires, or where `WCSession.isWatchAppInstalled` is still false/undefined during activation. The install flag is advisory for status text only; it does not gate payload writes. Unchanged payload signatures are re-written after a short TTL so a missed delivery or freshly installed watch app is not stuck behind a permanent "unchanged" skip.

**Phone-start behavior:** phone Start pre-stamps `activeWatchSessionId` / `activeWorkoutStartTime`, pushes an `active_snapshot` immediately, then calls the native bridge's `HKHealthStore.startWatchApp(with:)` path. The watch app handles that launch via `WKApplicationDelegate.handle(_:)`, requests a pull, and opens `ActiveWorkoutView` as soon as the active snapshot arrives. If watchOS declines the launch or reachability does not come up shortly after, the phone shows a nudge telling the user to open Thallo on the watch; the workout is already queued, so no second Start tap should be needed.

**Key implementation decisions:**
- `isPaired` silent gate **REMOVED** — it dropped payloads during transient unpaired states. Now only `isAvailable()` (platform support) gates pushes.
- `clearWatchData()` on sign-out pushes empty workout/meals/hydration/activity/supplements **and sleep/readiness/weight/templates** payloads (user-switch wipe), so no prior-user channel lingers in the watch's `applicationContext`.
- Workout clear is an explicit envelope `reason: "clear"` so stale completed/active payloads cannot rehydrate after logout or account switch.
- **Realtime `sendMessage` mirror covers every channel.** `ConnectivityStore.absorbMessage` switches on `kind` for all channels including `activity` and `templates` (previously those two only arrived via the slower `applicationContext` blob and were dropped from the realtime path).
- **Decoders are drift-tolerant.** The meal / supplement / readiness structs decode via flexible `init(from:)` helpers (matching the workout decoder), so a single type drift from the phone — a macro sent as `30.5` instead of `31`, a `null`, or a missing key — can no longer throw and silently blank an entire watch tab. Only the key *names* must still agree across the bridge.
- Setless cardio (`targetSets === 0`) is no longer marked done-on-arrival — `isDone` now requires `targetSets > 0`.
- **Watch meal day-totals mirror the phone.** `buildWatchMealsPayload.actual` sums **every visible meal**, not just checked ones, matching `NutritionCard`'s consumed total. `toggleMealLocal` flips only the per-meal checkbox and leaves `actual` untouched (the phone re-pushes authoritative totals after it persists the log). Previously the watch summed checked-only and the phone summed all-visible, so the wrist disagreed with the phone whenever a meal was unchecked.
- **Hydration ordering survives watch clock skew.** Incoming hydration pushes are ordered against the last *phone-authoritative* `syncedAtMs` (`lastHydrationPushMs`), not the live `hydration.syncedAtMs`. Optimistic local taps bump the live stamp to the watch's own clock for a fresh age reading; if the watch clock ran ahead of the phone, that made the phone's authoritative re-push look stale and get rejected — leaving the wrist stuck on the optimistic value. Phone is source of truth, so any push newer than the last accepted push wins.

## Watch App Pages

TabView: **Today** (workout) / **Meals** / **Hydration** / **Supps** / **Sleep** / **Readiness** / **Lifestyle** / **Quick Start** / **Weight**. Page dots always visible.

**Supps**: mirrors today's phone supplement stack grouped by custom `groupLabel` first, then timing bucket. Users can toggle one supplement, take a group, or take all pending supplements; phone persists through the supplements API and re-pushes authoritative state.

**Hydration**: quick-add 8 / 16 / 24 oz buttons, -8 oz correction, and a Digital Crown total setter. Watch quick-add/correction sends `log_hydration` deltas so queued taps compose after the phone wakes; Digital Crown set sends an absolute ounce total. Phone persists through `POST /meals/hydration` and re-pushes the server-computed target.

**Lifestyle**: quick logs stress, caffeine timing, alcohol, cannabis, digestion, illness, and appetite through `log_lifestyle`. Phone persists to `/lifestyle/daily/{date}` with source `watch`, invalidates readiness cache, re-pushes the saved lifestyle snapshot, and refreshes watch sleep/readiness signals for today.

Today and Hydration show a small phone-sync strip (`Phone live` / `Queued`, plus last workout/water age) that sends `pull_state` when tapped. The phone header mirrors the latest watch-sync result with a compact Watch pill.

**Active workout**: Digital Crown + −/+ steppers, manual reps/weight entry, recommended-weight quick-use row, rest timer, HR persistent chip, live recommendation text, swipe pages for workout plan/upcoming exercises and HR zones, warm-up card before first set, persistent warm-up block on the plan page, end + cancel + skip/swap-exercise menu. The user must confirm each set with `log_set` before anything reaches the phone/backend source of truth. Watch-added exercises are inserted optimistically with a client id while the phone echo reconciles later. When a set is logged from the watch while the phone app is suspended, the watch immediately shows a deterministic local next-set fallback and keeps the phone/backend recommendation as the later authoritative replacement. The plan page exposes future exercises, same-slot swaps, quick add from synced templates, and phone-generated core/stretch circuit requests. Outdoor cardio uses Watch GPS/location only during the active session for distance, pace, and route context; indoor cardio falls back to pedometer/native distance or manual distance entry depending on activity type. Mixed lift + cardio workouts start as strength for the lifting block, then the watch begins a cardio HealthKit activity and emits `cardio_metrics` when the active exercise is the cardio finisher.

**Start behavior**: watch Start is local-first. It immediately mints a local `sessionId`, presents `ActiveWorkoutView`, clears stale watch set state, and sends `start_workout` with that `sessionId` to the phone in the background. The phone reuses the watch-provided id for its active echo, so sets logged before the echo lands still belong to the same workout session. The phone still owns persistence, but the watch no longer waits on the phone echo or on a HealthKit workout session before tracking sets.

**HealthKit**: watch tracking uses `HKWorkoutSession` + `HKLiveWorkoutBuilder` for live heart rate/runtime, distance, and outdoor route context where available. Normal end calls `finishWorkout`, while cancel calls `discardWorkout`; Thallo's phone/backend session remains the workout source of truth for sets, recommendations, and plan completion.

## Active-State Persistence (#148) — IMPLEMENTED

`targets/thallo-watch/ActiveWorkoutView.swift::ActiveWorkoutState` persists `exerciseIndex` / `setNumber` / `restRemaining` / `restEndAtMs` / `sessionId` / `paused` / `pendingWeight` / `pendingReps` / `lastLoggedWeight` / `lastLoggedReps` / `currentRecommendation` / `liveRecommendedWeightLbs` / `liveRecommendedReps` / timed-exercise stopwatch state to UserDefaults via `didSet` on every `@Published`.

- `hydrate()` runs in `init` — backgrounded watch app re-mounts to exact state.
- `clearPersisted()` called on workout end/cancel.
- Hydrate guard (`hydrating = true`) prevents restore from re-triggering `persist()`.
- `attach(to:)` binds persisted state to the current workout `sessionId`; a new workout session resets stale set/rest state so prior sessions cannot show impossible counts like `4 of 3`.
- Rest countdowns persist as absolute end timestamps and are reconciled on timer ticks and SwiftUI `scenePhase == .active`, so watchOS sleep/wake does not freeze the timer.
- Recommendation hydration uses `state.currentRecommendation ?? ex.recommendation`, so the watch prefers fresh phone-pushed guidance during a live rest window and falls back to the static exercise recommendation when no live override exists.

## Rest-Over Alert (sound + haptic)

The watch rest countdown plays a haptic when it hits zero (`reconcileRestClock` → `WKInterfaceDevice.play(.notification)`), which still fires while backgrounded as long as the workout session keeps the app alive — but a haptic is silent. To also **ding** when the app is backgrounded or asleep, `ActiveWorkoutState.setRest` schedules a `UNTimeIntervalNotificationTrigger` local notification (identifier `"thallo.rest.timer"`) with `content.sound = .default` + `.timeSensitive` at the rest-end time. It is cancelled in `clearRest` (rest skipped / re-armed) and `clearPersisted` (workout end/cancel); natural completion clears `restEndAtMs` *without* `clearRest`, so the pending notification survives to fire. `AppDelegate` is the `UNUserNotificationCenterDelegate` and returns `[.sound]` from `willPresent` so the ding also plays in the foreground. Authorization (`[.alert, .sound]`) is requested once on first arm.

Phone-side, the rest alert is gated by dedicated `restSoundEnabled` / `restHapticEnabled` toggles in `feedback.ts` (Settings → Feedback & Device), independent of the global app sound/vibration switches.

**TODO (open):** sync `restSoundEnabled` / `restHapticEnabled` to the watch so the ding/haptic respect them, and gate the *background* phone rest notification's sound in `restNotifications.ts`. Today the watch ding always plays when notifications are authorized.

## Watch Complication + Smart Stack (#110 — IMPLEMENTED)

`targets/thallo-watch-complication/` — watchOS WidgetKit extension embedded in `ThalloWatch.app`. Ships separate static complication choices for Daily Summary, Workout, Readiness, Sleep, and Water across accessoryCircular / accessoryRectangular / accessoryInline. The existing `ThalloWatchComplication` kind remains the Daily Summary option so installed watch faces keep working after updates.

**Data path:** `targets/thallo-watch/ConnectivityStore.swift` mirrors the latest workout / hydration / activity steps / readiness / sleep snapshot into SharedDefaults `group.com.thallo.app` via `ThalloComplicationSync`, then calls `WidgetCenter.shared.reloadAllTimelines()`.

**Actions:** widget links open the watch app through the `thallowatch://` URL scheme. `thallowatch://start-workout` starts or rejoins today's workout through the existing watch `start_workout` command path. Hydration widget links open the Hydration page only; water is logged only from explicit controls inside the watch or phone app. Phone/backend remain authoritative.

**Signing requirement:** the App Group `group.com.thallo.app` must be enabled for both `com.thallo.app.watch` and `com.thallo.app.watch.widget` in Apple Developer before device/TestFlight signing.

## Siri Intent Scaffold (#111 — NOT YET SHIPPED)

`ios-extras/StartWorkoutAppIntent.swift` — drop-in `AppIntent` source that opens `thallo://start-workout`. The JS deep-link handler is wired in `app/index.tsx`, but the native Intents extension target is not yet part of the build.

**Blocked until:** Intents extension target added in Xcode / Expo targets, file assigned to that target, and intent metadata declared in the native app bundle.

## Payload Change Rules

When changing WCSession payloads:
1. Update `modules/thallo-watch-bridge/` (phone side).
2. Update `targets/thallo-watch/ConnectivityStore.swift` + any Swift structs that decode the payload.
3. Both sides must agree on field names — Swift `Codable` will silently ignore extra fields but fail on type mismatches.
