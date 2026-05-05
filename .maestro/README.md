# Thallo — Maestro mobile UI tests

End-to-end smoke flows that exercise the Expo React Native app on a real
simulator / device. Intended to catch the class of bugs we've been fighting:

- Backend returns a correct plan but the UI paints a stale one (cache staleness)
- Goal-save double-confirm modal chain breaks
- Inline pace picker regresses on the goal step
- Target-weight "required" asterisk / direction rule bypass
- Plan card renders without a focus, or with back-to-back same-family focuses
- ShimmerLogo overlay missing during regen (silent blocking work)
- Start Workout CTA fails to navigate to ActiveWorkoutScreen
- Active workout RIR prompt fails to appear after a meaningful over-target set

## Install Maestro

The sandboxed shell on CI may block the install curl. Run this locally:

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Then restart your shell (or `source ~/.zshrc`) and verify:

```bash
maestro --version
```

Docs: https://maestro.mobile.dev/

## Run the smoke flow

Prereqs:

1. Backend is up: `docker compose up -d` (or Makefile target `make start`)
2. Metro bundler is running: `npx expo start` (or `make start`)
3. An iOS Simulator is booted with either Expo Go or a Thallo dev build installed
   — or an Android emulator / real device attached via ADB.

Then:

```bash
MAESTRO_DRIVER_STARTUP_TIMEOUT=120000 maestro test .maestro/flows/signup-and-regen.yaml
```

Or via the Makefile shortcut:

```bash
make smoke-mobile
```

The Makefile smoke targets set `MAESTRO_DRIVER_STARTUP_TIMEOUT=120000` by
default because Maestro 2.5.x can be slow to bring up the iOS XCTest driver.

## Seeded returning-user flow

The signup flow should remain the main lifecycle smoke. For faster
returning-user regression coverage, seed deterministic E2E personas first:

```bash
make seed-e2e
maestro test .maestro/flows/seeded-returning-user.yaml
```

Or run both through the Makefile shortcut:

```bash
make smoke-mobile-seeded
```

## Workout + tier-gate flows

Additional seeded E2E coverage:

```bash
make seed-e2e
maestro test .maestro/flows/recovery-live-workouts.yaml
maestro test .maestro/flows/workout-templates.yaml
maestro test .maestro/flows/active-workout-swap-recommendations.yaml
maestro test .maestro/flows/active-workout-completion.yaml
```

Or:

```bash
make smoke-mobile-workouts
```

Plan-adaptation coverage for history-aware PPL ordering and coach recovery
apply/render behavior:

```bash
make seed-e2e
maestro test .maestro/flows/ppl-history-ordering.yaml

make seed-e2e-recovery-apply
maestro test .maestro/flows/recovery-recommendation-apply.yaml
```

Or:

```bash
make smoke-mobile-plan-adaptation
```

State-mutation coverage for meals, hydration, and supplements:

```bash
make seed-e2e
maestro test .maestro/flows/activity-nutrition-hydration.yaml
maestro test .maestro/flows/meals-supplements-state.yaml
maestro test .maestro/flows/meal-history-facts-alignment.yaml
```

Or:

```bash
make smoke-mobile-state
```

Seeded social graph, digest, and sharing-off privacy branch:

```bash
make seed-e2e
maestro test .maestro/flows/social-digest.yaml
```

Or:

```bash
make smoke-mobile-social
```

Account, settings, auth recovery, and active PlanWeek immutability checks:

```bash
make seed-e2e
maestro test .maestro/flows/plan-settings-immutability.yaml
maestro test .maestro/flows/account-settings-state.yaml
maestro test .maestro/flows/auth-recovery.yaml
```

Or run the main seeded preflight pack with fresh seed data between mutating
flows:

```bash
make smoke-mobile-preflight
```

Free-vs-Pro gates need beta full-access disabled for the running JS bundle:

```bash
EXPO_PUBLIC_DISABLE_FREE_BETA_FULL_ACCESS=1 npx expo start --dev-client
make smoke-mobile-free-gates
```

Seeded credentials:

- `e2e_returning@test.thallo` / `SeedTest1234` — pro returning user with active
  PlanWeek, meals, progress, social, gear, and supplement data.
- `e2e_live_swap@test.thallo` / `SeedTest1234` — pro live-workout swap fixture
  with a seeded bench target and shoulder-press history.
- `e2e_long@test.thallo` / `SeedTest1234` — pro 90-minute workout persona.
- `e2e_social_a@test.thallo` / `SeedTest1234` and
  `e2e_social_b@test.thallo` / `SeedTest1234` — friend graph fixtures.
- `e2e_ppl_open@test.thallo` / `SeedTest1234` — pro PPL user whose recent
  Push/Pull history leaves Legs most open for plan-order assertions.
- `e2e_recovery_apply@test.thallo` / `SeedTest1234` — pro PPL user for
  recovery-recommendation apply/render assertions.
- `e2e_activity_nutrition@test.thallo` / `SeedTest1234` — pro rest-today user
  for live activity-driven nutrition and hydration assertions.
- `e2e_free@test.thallo` / `SeedTest1234` — free entitlement control.

## iOS simulator vs device vs Android

Maestro auto-detects whatever's running. If multiple devices are attached,
pass `--device`:

```bash
# List booted devices
maestro test --help                    # shows global flags
xcrun simctl list devices booted       # iOS
adb devices                            # Android

# Target a specific device
maestro --device "iPhone 15 Pro" test .maestro/flows/signup-and-regen.yaml
maestro --device emulator-5554          test .maestro/flows/signup-and-regen.yaml
```

## App ID — Expo Go vs release build

`.maestro/flows/*.yaml` default to `appId: com.thallo.app` (matches `app.json`
on both iOS and Android release builds, and the dev client).

If you're running the app through **Expo Go** instead of a dev client / release
build, the bundle id is different. Change the `appId:` lines at the top of each
flow to:

- iOS Expo Go: `host.exp.Exponent`
- Android Expo Go: `host.exp.exponent`

## Helper: login.yaml

Logs in an existing user instead of creating a new one. Used standalone or via
`runFlow` from another flow:

```bash
maestro test \
  -e TEST_EMAIL=smoke@thallo.test \
  -e TEST_PASSWORD='SomeStrongPw!' \
  .maestro/flows/login.yaml
```

## Known pitfalls

- **Timing tuned for ~60s plan gen.** If your backend / OpenAI round-trip is
  slow (weak wifi, cold worker), bump the `timeout: 120000` on the plan-gen
  `extendedWaitUntil` in `signup-and-regen.yaml` to `180000` or higher.
- **Expo Go bundle id differs.** See section above — default is the release
  `com.thallo.app`.
- **Dev-client native module drift.** If a run black-screens and Metro reports
  `Cannot find native module 'ExpoWebBrowser'` or similar, rebuild/reinstall the
  dev client (`npx expo run:ios` or the matching Android command) before
  re-running Maestro.
- **iOS driver startup flake.** If Maestro exits before a flow starts with
  `iOS driver not ready in time`, rerun through the Makefile target or export
  `MAESTRO_DRIVER_STARTUP_TIMEOUT=120000`.
- **Light vs dark theme copy.** Flows match on user-visible text. Current copy
  is theme-invariant, but if a future theme overrides labels (e.g. "Get Started"
  → "Start"), the flow will need updating.
- **`clearState: true` wipes the app container.** Signup flow runs fresh every
  time — good for isolation, bad if you want to layer on top of cached data.
  Drop to `clearState: false` to reuse state.
- **Accessibility labels + testIDs.** On iOS, Maestro `tapOn` prefers accessibility
  labels. We added a handful of semantic testIDs (`shimmer-logo`,
  `edit-profile-save`, `pace-picker-inline`, `goal-card-<goalId>`) — see the
  RN source for where.
- **Signup emails are unique per run.** The flow generates
  `smoke+<timestamp>@thallo.test` so you don't have to clean up the DB between
  runs. If your backend enforces email-verification, this flow will stall.
- **Back-to-back focus check is heuristic.** We assert `"Push Push"` etc. are
  NOT visible. Doesn't catch "Push, then Push on a non-adjacent card"
  — by design; the planner test in `backend/tests` covers that case.

## Updating the flow

- Prefer anchoring on accessibility labels or `testID`s over raw text whenever
  possible — text copy churns, testIDs don't.
- If the flow breaks because a label changed, either update the label in the
  flow or add a `testID` to the RN component and swap the flow to `id:`.
- Run locally before pushing — Maestro has no static linter beyond what the CLI
  does at flow-load time, so a syntax error only surfaces at test start.

## Files

- `flows/signup-and-regen.yaml` — the critical smoke flow (signup → onboarding
  → plan gen → equipment toggle regen → Start Workout)
- `flows/seeded-returning-user.yaml` — returning-user smoke flow backed by
  `make seed-e2e`
- `flows/recovery-live-workouts.yaml` — manual recovery logging plus live
  tracker finish → confirmation save
- `flows/workout-templates.yaml` — build a template from the exercise library
  and launch it into ActiveWorkoutScreen
- `flows/ppl-history-ordering.yaml` — verifies PPL can start with the most-open
  family, then continue through the remaining PPL families
- `flows/recovery-recommendation-apply.yaml` — verifies a coach-applied
  recovery override renders as a Recovery Day in the Plan tab
- `flows/active-workout-completion.yaml` — inline set logging → finish
  confirmation → post-workout summary → workout history
- `flows/meals-supplements-state.yaml` — hydration quick-add, favorite meal
  quick-log, meal history, supplement add + mark-taken
- `flows/meal-history-facts-alignment.yaml` — verifies Meal History, Nutrition
  Trend, and Nutrition & Gut Facts read the same seeded backend meal-history
  totals
- `flows/social-digest.yaml` — verifies seeded Activity feed, friend list,
  friend detail workout rows, and sharing-off privacy messaging
- `flows/plan-settings-immutability.yaml` — verifies future workout settings
  saves do not mutate the fixed active 7-day PlanWeek
- `flows/account-settings-state.yaml` — verifies Profile → Settings → Account,
  legal review, and tutorial replay modal routing
- `flows/auth-recovery.yaml` — verifies recovery-question password reset for
  seeded users and the post-reset login path
- `flows/free-vs-pro-gates.yaml` — true free tier vs pro gate assertions
  (requires `EXPO_PUBLIC_DISABLE_FREE_BETA_FULL_ACCESS=1`)
- `flows/login.yaml` — helper flow for logging in an existing user
- `flows/progress-1rm-consistency.yaml` — verifies the rolling-e1RM
  showcase tile and per-PR cards both render after the overlay change
  (guards against the chart/showcase/PR-card drift the user reported)
- `flows/meal-search-thallo-badge.yaml` — verifies food search in the
  meal-edit modal renders the THALLO badge for stored foods (label
  was unified across seed + user-added custom foods on 2026-05-04)

### Theme + UI invariants

- `flows/theme-onyx-contrast.yaml` — switch to Onyx theme, verify
  Start Workout button still visible (guards same-color-on-same-color)
- `flows/theme-paper-contrast.yaml` — switch to Paper theme, verify
  AI coach send button stays reachable
- `flows/workout-cards-collapsed-default.yaml` — workout day cards
  start collapsed (recent UX change; previously auto-expanded)
- `flows/tutorial-replay.yaml` — Settings → Replay tutorial mounts the
  tutorial overlay with a working skip button
- `flows/onboarding-equipment-toggle.yaml` — fresh signup gets through
  the equipment toggle step without errors

### Settings / reminders / auth

- `flows/meal-reminder-schedule-edit.yaml` — meal reminder schedule
  selector persists across screen round-trip (every_day/training_days)
- `flows/workout-reminder-schedule-edit.yaml` — workout reminder time
  +/- adjuster + skip-completed toggle work
- `flows/quiet-hours-toggle.yaml` — quiet-hours toggle + endpoint
  +/- controls render and remain mounted
- `flows/account-details-fast-open.yaml` — Account Details opens
  within 5s (SWR-cache hit; previously took 10+s)
- `flows/logout-and-relogin.yaml` — sign out routes to AuthScreen,
  re-login lands back on Plan without ghost state

### Workout flows

- `flows/switch-day-rest-to-workout.yaml` — pick a workout for a
  rest day (fix for short-circuit guard on null item.workout)
- `flows/start-workout-active-screen.yaml` — Start Workout CTA
  mounts ActiveWorkoutScreen with reachable live controls
- `flows/workout-history-row-detail.yaml` — Workout History tab
  renders rows for the seeded user
- `flows/workout-subtab-navigation.yaml` — cycle Plan/Library/
  History/Settings without error boundaries
- `flows/workout-template-build.yaml` — build a custom template,
  add an exercise, save, verify it appears in the listing

### Meals / Progress / Social

- `flows/hydration-large-bottles.yaml` — +40oz quick-add button
  (recent feature) wires through state
- `flows/nutrition-trend-renders.yaml` — Progress Nutrition Trend
  card renders + at least one logged-cal pip is visible
- `flows/nutrition-gut-facts-toggle.yaml` — Gut/Nutrition facts
  toggle stays mounted across switches
- `flows/progress-weight-card.yaml` — Progress weight card renders
  with a current value and unit suffix
- `flows/social-friend-detail-back.yaml` — friend detail screen
  navigation: open from list → assert content → back-nav
