# UI Layout

Last updated: 2026-05-01

## Tab Structure

### Workout Tab
- **Plan** — fixed 7-day **PlanWeek** schedule (Mon-Sun, anchored on the
  most recent Monday). Renders a compact weekly selector in chronological
  order, then one full selected-day card. Past days show as completed /
  skipped in the selector, today is selected by default and keeps a persistent
  top dot when another day is selected, and forward days remain queued. The 7
  days are stable for the full week — no mid-week regeneration.
  Each selected day card has per-exercise Swap chip → `PlanSwapExerciseModal`.
  Today's selected day also renders extra-workout cards for live custom
  tracking, manual logging, and detected Apple Health imports.
- **Library** — Exercises browser. The former Muscles tab is removed from the
  workout library surface.
- **Settings** — equipment, injuries, preferences.

### Meals Tab
- **Plan** — daily meal plan. Renders a compact weekly selector, then one full
  selected-day meal card. Today is selected by default, hydration is embedded inside
  the Today card, and favorites/saved meals, catch-up nudges, fueling/recovery
  signals, and adaptive macros sit below Today.
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

## Day Card Behavior (PlanWeek)

- `isToday` is **date-based** (`dateKey(item.date) === todayKey()`) — with
  the dated PlanWeek, today may be at any index (e.g., index 1 if the
  week started Monday and today is Tuesday).
- `isCompleted` derives from `completedDates.has(key)` so any past day's
  completed workout shows as done (yesterday rendering as ✓ done is the
  user-visible signal that the schedule reflects history).
- `completedSummary` is looked up per-date in `workoutHistorySummaries`,
  not from a single `todaySummary` value, so each past day shows its own
  stored summary card.
- Day-of-week label resolves to "Yesterday" / "Today" / "Tomorrow" for
  adjacent days, weekday name otherwise.
- Auto-renew: when the active PlanWeek's `end_date < today`, `loadPlans`
  calls `POST /plans/week/auto-renew` and renders the freshly generated
  next 7 days. The prior week's coach check-in remains available for one
  day; applying changes refreshes the current week's remaining unlocked
  days. If ignored, the generated week stays as-is and the recap remains
  visible from Progress.

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
- Smart weekly check-in modal leads with a date-stamped "TRAINER'S READ" block + inline Apply pills.
- Friends modal: Activity feed tab + Friends tab with THIS WEEK digest, REQUESTS/FRIENDS/SENT sections, and ADD FRIENDS search.
