# Claude Rules — Apple Watch

When editing `targets/thallo-watch/` or `modules/thallo-watch-bridge/`:

1. **Both sides must stay in sync**: A payload change requires updating both the phone bridge (`modules/thallo-watch-bridge/`) and the watch decoder (`targets/thallo-watch/ConnectivityStore.swift`). Swift `Codable` silently ignores extra fields but fails on type mismatches.

2. **No `isPaired` gate**: Do not re-add `isPaired` checks before pushes — they silently drop payloads during transient unpaired states (reboot, session activation). Only `isAvailable()` gates pushes.

3. **User-switch wipe**: `clearWatchData()` on sign-out must push empty payloads for workout, meals, and supplements. Do not skip this.

4. **Active-state persistence**: `ActiveWorkoutState` persists to UserDefaults via `didSet` on every `@Published`. Do not add new `@Published` fields without also persisting + restoring them in `hydrate()` / `persist()`.

5. **Complications + Siri stubs**: `targets/thallo-watch-complication/` and `ios-extras/StartWorkoutAppIntent.swift` are scaffolds that require manual Xcode wiring. Do not try to ship them via code changes alone — they need target + entitlement setup in Xcode.

6. **HK workout writes**: Phone-side sessions go through `saveWorkoutToHealth` in `modules/thallo-healthkit/`. Watch-started sessions write via `HKLiveWorkoutBuilder.finishWorkout`. Do not duplicate the write path.
