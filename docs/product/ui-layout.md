# UI Layout

Last updated: 2026-05-07

## Tab Structure

Bottom nav has five destinations: **Friends**, **Workouts**, **Meals**, **Progress**, and **You**.

### Workout Tab
- **Plan** — fixed 7-day **PlanWeek** schedule anchored on the user's own
  start-day cadence. Renders a compact weekly selector in chronological
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

### Progress Tab
- **Today** — goal-aware on-track check using the user's active goal, current week pace, strength trend, cardio trend, weight/body trend, and nutrition signal; also owns actionable current-week surfaces such as in-progress workout resume, the weekly check-in card, and Zone 2 plan-week progress.
- **Trends** — strength/cardio charts, top estimated 1RM, PRs, workout calendar, chronological session history, goal history, AI summaries, and scheduled change history.
- **Body** — per-muscle recovery, muscle balance, weight history, measurements, and body-scan history.
- **Health** — Apple Health vitals, detected Apple Health workout imports, stored Health/Sleep history, and Nutrition & Gut Facts (adaptive window up to 14 days).
- Tab transitions: `FadeInView` keyed on tab + haptic selection.

### Friends Tab
- **Activity** — bounded friends-only workout activity feed for self + friends with sharing enabled.
- **Friends** — THIS WEEK digest, requests/friends/sent rows, ADD FRIENDS search, and notification tray.

### You Tab
- Account/profile entry points, theme, Gear tracker, Settings, body/profile edits, and tutorial/legal/account actions.

## UI Helpers + Conventions

- `shouldHideWeight` / `shouldHideReps` (`exerciseDisplay.ts`) — single source of truth for bodyweight + stretch exercise display.
- Per-exercise muscle chips: `WorkoutCard` reads `primary_muscle` directly. Day-card chip aggregation is family-filtered to focus. Mobility/recovery days collapse to "Mobility" / "Recovery" label.
- **Change Focus picker** (allow-with-warnings): every target focus is selectable with readiness chip + conflict warning. (Previously labeled "Switch Day" — renamed to "Change Focus" in Apr 2026.)
- Exercise swap overlap meter: 0-100% by muscle overlap — ≥80% green / ≥60% amber / lower red. Logged sets carry over on swap. Shared `swapScoring.ts` function.
- Regen overlays use `ShimmerLogo` for loading state.
- `configureExpandAnimation(300)` spring preset for all card expand/collapse — replaces `LayoutAnimation.Presets.easeInEaseOut` which renders imperceptibly fast in iOS release builds.

## Onboarding / Goal Flow

- First step is a setup path picker:
  - **Quick Start** — goal → templates → body stats. Users pick training,
    equipment, and optional food-style templates, then fine-tune later from
    profile/settings. Copy frames this as best for newer users or anyone who
    wants the fastest setup.
  - **Advanced Setup** — preserves the detailed flow for users with fitness-app
    experience or known schedule, split, equipment, food, baseline, and
    restriction preferences.
- ACID-style finalize: auth token, username, last user ID, profile writes all deferred to end of flow.
- Pace picker: conservative / moderate / aggressive — haptic selection.
- Target weight is required for weight-change goals in the detailed path, but
  optional in Quick Start so users can see value before choosing an exact
  endpoint.
- `FadeInView` keyed on `currentStepKey` for step transitions (220ms).
- Horizontal template scrollers use `decelerationRate="fast"`.

## Day Card Behavior (PlanWeek)

- `isToday` is **date-based** (`dateKey(item.date) === todayKey()`) — with
  the dated PlanWeek, today may be at any index after the first day of the
  user's personal 7-day cadence.
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
  day. Applying check-in recommendations saves durable settings / coach
  state for future generated weeks; the active 7-day PlanWeek stays
  fixed. If ignored, the generated week stays as-is and the recap remains
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
- Friends modal: Activity feed tab + Friends tab with THIS WEEK digest, REQUESTS/FRIENDS/SENT sections, and ADD FRIENDS search. Expanded workout cards use spring animation and show recorded workout-only load/time/distance details.
