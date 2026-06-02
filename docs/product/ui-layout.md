# UI Layout

Last updated: 2026-05-22

## Tab Structure

Bottom nav has five destinations: **Friends**, **Workouts**, **Today**, **Meals**, and **Progress**. **You** lives behind the top-right avatar.

### Today Tab
- Clean daily landing surface with a time-aware personalized greeting. Shows the primary workout action with the same workout-photo language as the plan card, the same focus title + colored stimulus oval used by the workout page, steps, the same compact macro cards used by Meals, a direct Log meal action, quick water logging, plus compact sleep, goal, nutrition, and readiness tiles.
- Macro targets use the same adjusted daily target source as Meals, with calculated fallback targets for empty/manual/free days.
- Empty workout days show a custom-workout starting point instead of a blank recovery state.
- Home sections use subtle staggered entrance motion. Sleep uses a compact dark night-sky score tile with gentle star twinkle and deep-links to the Progress Today sleep card. Readiness opens an in-place detail sheet instead of navigating away.
- Post-onboarding and live tutorials introduce Today as the home base, including free/manual custom-workout, Log meal, macro, water, sleep, and readiness paths.
- The workout hero card background opens the Workouts week; only explicit action pills like Start or Resume perform the action. "View Week" is not rendered as its own pill.
- The workout action reads from the active dated `PlanWeek` / `PlanDay` row, not a regenerated rolling day.
- Goal ETA uses the deterministic goal estimate helper and sleep reads from the cached health summary.

### Workout Tab
- **Plan** — fixed 7-day **PlanWeek** schedule anchored on the user's own
  start-day cadence. Renders a compact weekly selector in chronological
  order, then one full selected-day card. Past days show as completed /
  skipped in the selector, today is selected by default and keeps a persistent
  top dot when another day is selected, and forward days remain queued. The 7
  days are stable for the full week — no mid-week regeneration.
  Each selected day card has per-exercise Swap chip → `PlanSwapExerciseModal`.
  Today's selected day also renders extra-workout controls for live custom
  tracking, manual logging, compact Apple Health imports, and saved templates.
  Outdoor run/walk/ride/hike custom tracking can show live GPS distance, pace,
  and route map; indoor cardio avoids location and uses manual/device distance.
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
- **Today** — goal-aware on-track check using the user's active goal, current week pace, strength trend, cardio trend, weight/body trend, and nutrition signal; also surfaces the aggregate Thallo Score plus actionable current-week surfaces such as in-progress workout resume, the weekly review card, and Zone 2 plan-week progress.
- Daily Stress Timeline — Today card that models the day from logged meals, workouts/activity, and optional HR samples. It persists the daily average and shows a personal-baseline comparison plus a compact daily-average history strip.
- **Trends** — strength/cardio charts, top estimated 1RM, PRs, workout calendar, chronological session history, goal history, AI summaries, and scheduled change history.
- **Body** — per-muscle recovery, muscle balance, weight history, measurements, and body-scan history.
- **Health** — Apple Health vitals, sleep detail, Labs, Hormone + Cellular Signals, Nutrition & Gut Facts (adaptive window up to 14 days), and sun exposure.
- **Insights** — Pro-only wellness pattern cards with a data-coverage summary first; "Needs data" cards stay behind their own filter instead of crowding the default All view.
- Tab transitions: `FadeInView` keyed on tab + haptic selection.

### Friends Tab
- **Activity** — bounded friends-only workout activity feed for self + friends with sharing enabled.
- **Friends** — ADD FRIENDS search and accepted friend circles only.
- **Profile** — own social profile, incoming friend invites, sent requests, sharing controls, invite handle, and notification tray.

### You Surface (Avatar)
- Account/profile entry points, theme, Gear tracker, Settings, body/profile edits, and tutorial/legal/account actions.
- Settings includes a **Coach** section for trainer mode: trainer profile,
  client invite, user-to-trainer invite, pending approvals, client adherence
  dashboard, and trainer-private client notes. Trainer access is separate from
  Social and uses explicit per-relationship permissions for workouts,
  nutrition, body metrics, and recovery visibility.
- Recommended next cleanup: make Settings the stable hub for Import, Notifications, Units, Data & Privacy, Watch/Health, Account, Gear, Theme, and Legal. Import is already reachable from Settings; pending-import banners should route users back there rather than opening a one-off modal.

## UI Helpers + Conventions

- `shouldHideWeight` / `shouldHideReps` (`exerciseDisplay.ts`) — single source of truth for bodyweight + stretch exercise display.
- Per-exercise muscle chips: `WorkoutCard` reads `primary_muscle` directly. Day-card chip aggregation is family-filtered to focus. Mobility/recovery days collapse to "Mobility" / "Recovery" label.
- **Change Focus picker** (allow-with-warnings): every target focus is selectable with readiness chip + conflict warning. (Previously labeled "Switch Day" — renamed to "Change Focus" in Apr 2026.)
- Exercise swap overlap meter: 0-100% by muscle overlap — ≥80% green / ≥60% amber / lower red. Logged sets carry over on swap. Shared `swapScoring.ts` function.
- Regen overlays use `ShimmerLogo` for loading state.
- `configureExpandAnimation(300)` spring preset for all card expand/collapse — replaces `LayoutAnimation.Presets.easeInEaseOut` which renders imperceptibly fast in iOS release builds.

## Onboarding / Goal Flow

- Onboarding starts with app focus (fitness, nutrition, or both). If fitness is
  included, users then choose a workout workflow: **Build my plan for me**,
  **Log my own workouts**, or **Mix both**. Generated plans remain a Pro value
  prop; Free is framed as manual workouts, custom logging, and starter saved
  templates.
- Setup path picker:
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
- Post-onboarding tutorial explains the tier split without blocking signup:
  Free is manual tracking + starter template limits, while Pro adds generated
  PlanWeeks, AI coaching/scans, readiness, and advanced insights. Tutorial also
  calls out custom workouts, saved templates, and starting custom sessions from
  Workouts.

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
  next 7 days. The prior week's review remains available for one day as an
  informational surface. If the new week is already generated, setup edits can
  either wait for future generated weeks or rebuild remaining unlocked days in
  the current week. Completed, skipped, and started days stay locked. If
  ignored, the generated week stays as-is and the recap remains visible from
  Progress.

## Key UI Features

- Exercise dislike excludes from future plans.
- Recovery badge with per-muscle bars. Headline score/label is derived from the visible per-muscle bars (not the backend readiness score, which also folds in hidden systemic/density load); "Highest load" only flags muscles below 60% recovery. The old aggregate "Overall Load" bar was removed.
- Nutrition insight in recovery card when expanded.
- Resume workout modal only if sets logged.
- Rest timer with deterministic in-workout progression guidance badge.
- Outdoor-cardio live tracker map + post-workout route summary when location is granted.
- AppState listener catches up timers on foreground return.
- Workout start time persists to AsyncStorage.
- History export: PDF via expo-print.
- Activity log includes: Yard Work, Chopping Wood, Moving/Lifting, Gardening, House Cleaning, Construction, Shoveling, Playing w/ Kids, Dancing.
- Sports: Pickleball, Surfing, Skiing, Spin Class.
- Weekly review modal is informational and can optionally save explicit plan setup changes.
- Friends modal: Activity feed tab + Friends tab with ADD FRIENDS search and accepted friend circles. Request/sent rows live in Profile. Expanded workout cards use spring animation and show recorded workout-only load/time/distance details.
