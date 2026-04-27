# UI Layout

Last synced from CLAUDE.md: 2026-04-27

## Tab Structure

### Workout Tab
- **Plan** — weekly workout plan cards. Each day card has per-exercise Swap chip → `PlanSwapExerciseModal`.
- **Library** — merged Exercises + Muscles browser.
- **Settings** — equipment, injuries, preferences.

### Meals Tab
- **Plan** — daily meal plan. `IncompleteDayBanner` + `FuelingRecoveryCard` mount above cards (both conditional).
- **Foods** — search + targets + "YOUR FAVORITES" horizontal scroll of common meals.
- **Supps** — supplements.

### Progress Screen Tabs
- **Health** — Apple Health vitals + Nutrition & Gut Facts (adaptive window up to 14 days) + Muscle Balance.
- **Body** — per-muscle recovery (`RecoveryCard`) + weight trend.
- **PRs** — personal records.
- **Charts** — strength + consistency charts.
- Tab transitions: `FadeInView` keyed on tab + haptic selection.

## UI Helpers + Conventions

- `shouldHideWeight` / `shouldHideReps` (`exerciseDisplay.ts`) — single source of truth for bodyweight + stretch exercise display.
- Per-exercise muscle chips: `WorkoutCard` reads `primary_muscle` directly. Day-card chip aggregation is family-filtered to focus. Mobility/recovery days collapse to "Mobility" / "Recovery" label.
- **Change Focus picker** (allow-with-warnings): every target focus is selectable with readiness chip + conflict warning. (Previously labeled "Switch Day" — renamed to "Change Focus" in Apr 2026.)
- Exercise swap overlap meter: 0-100% by muscle overlap — ≥80% green / ≥60% amber / lower red. Logged sets carry over on swap. Shared `swapScoring.ts` function.
- Regen overlays use `ShimmerLogo` for loading state.
- `configureExpandAnimation(300)` spring preset for all card expand/collapse — replaces `LayoutAnimation.Presets.easeInEaseOut` which renders imperceptibly fast in iOS release builds.

## Onboarding / Goal Flow

- ACID-style finalize: auth token, username, last user ID, profile writes all deferred to end of flow.
- Pace picker: conservative / moderate / aggressive — haptic selection.
- Target weight required for weight-change goals (fat_loss / muscle_gain / body_recomp / toning).
- `FadeInView` keyed on `currentStepKey` for step transitions (220ms).
- Horizontal template scrollers use `decelerationRate="fast"`.

## Key UI Features

- Exercise dislike excludes from future plans.
- Recovery badge with per-muscle bars; "Overall Load" label.
- Nutrition insight in recovery card when expanded.
- Resume workout modal only if sets logged.
- Rest timer with AI recommendation badge.
- AppState listener catches up timers on foreground return.
- Workout start time persists to AsyncStorage.
- History export: PDF via expo-print.
- Activity log includes: Yard Work, Chopping Wood, Moving/Lifting, Gardening, House Cleaning, Construction, Shoveling, Playing w/ Kids, Dancing.
- Sports: Pickleball, Surfing, Skiing, Spin Class.
- Smart weekly check-in modal leads with "TRAINER'S READ · THIS WEEK" block + inline Apply pills.
- Friends modal: THIS WEEK digest + REQUESTS/FRIENDS/SENT sections + ADD FRIENDS search.
