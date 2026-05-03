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
maestro test .maestro/flows/signup-and-regen.yaml
```

Or via the Makefile shortcut:

```bash
make smoke-mobile
```

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
maestro test .maestro/flows/active-workout-completion.yaml
```

Or:

```bash
make smoke-mobile-workouts
```

State-mutation coverage for meals, hydration, and supplements:

```bash
make seed-e2e
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

Free-vs-Pro gates need beta full-access disabled for the running JS bundle:

```bash
EXPO_PUBLIC_DISABLE_FREE_BETA_FULL_ACCESS=1 npx expo start --dev-client
make smoke-mobile-free-gates
```

Seeded credentials:

- `e2e_returning@test.thallo` / `SeedTest1234` — pro returning user with active
  PlanWeek, meals, progress, social, gear, and supplement data.
- `e2e_long@test.thallo` / `SeedTest1234` — pro 90-minute workout persona.
- `e2e_social_a@test.thallo` / `SeedTest1234` and
  `e2e_social_b@test.thallo` / `SeedTest1234` — friend graph fixtures.
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
- `flows/active-workout-completion.yaml` — inline set logging → finish
  confirmation → post-workout summary → workout history
- `flows/meals-supplements-state.yaml` — hydration quick-add, favorite meal
  quick-log, meal history, supplement add + mark-taken
- `flows/meal-history-facts-alignment.yaml` — verifies Meal History, Nutrition
  Trend, and Nutrition & Gut Facts read the same seeded backend meal-history
  totals
- `flows/social-digest.yaml` — verifies seeded Activity feed, friend list,
  friend detail workout rows, and sharing-off privacy messaging
- `flows/free-vs-pro-gates.yaml` — true free tier vs pro gate assertions
  (requires `EXPO_PUBLIC_DISABLE_FREE_BETA_FULL_ACCESS=1`)
- `flows/login.yaml` — helper flow for logging in an existing user
