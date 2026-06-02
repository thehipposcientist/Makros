# Plan Persistence + Cache — Architecture

Last updated: 2026-05-07

## Source of Truth: PlanWeek

The front-page schedule is driven by **`PlanWeek` + 7 `PlanDay` rows**, one
active set per user. Each `PlanWeek` carries `start_date`, `end_date`,
`status`, and `planner_version`; each `PlanDay` carries `day_date`, `status`
(`pending` / `in_progress` / `completed` / `skipped`), `is_rest`, `locked`,
`workout_json`, and `nutrition_json`. The 7 days are generated once at week
start and **never regenerated mid-week** — past days accumulate as done /
skipped, today is highlighted, future days remain queued. The first week is
anchored on the user's start day; later weeks renew from `prev.end_date + 1`.
A new `PlanWeek` is only generated when the previous one's `end_date < today`
(auto-renew).

The legacy `WorkoutPlan` + `NutritionPlan` tables remain for the AI plan
artifact / nutrition templates, but the front-page rendering no longer
indexes into them via a cycling array.

## Endpoints

- `GET /plans/week/active` — returns the active `PlanWeek` (with all 7
  `PlanDay` rows), or `null` if the user has none yet. Response includes
  `needs_new_week: bool` so the client can decide whether to call
  auto-renew.
- `POST /plans/start-new-week` — generates a fresh 7-day plan anchored on
  **today**. Used for first-run setup / explicit new-week creation. Runs the
  deterministic workout planner + nutrition assembler, then persists into
  `plan_weeks` + `plan_days`.
- `POST /plans/week/auto-renew` — when the active week's `end_date` has
  passed, generates the next 7 days from `prev.end_date + 1`. It also snapshots the
  expired week into `plan_week_checkins` so the user has one day to review
  an informational week summary and choose whether explicit setup changes (goal, training
  days, split, session length) should wait for future generated weeks or
  rebuild remaining unlocked days in the already-generated current week. If the
  user ignores it, the generated week stays as-is and the recap remains readable.
  Idempotent: a no-op while the current week is still active.
- `POST /plans/week/pause` / `POST /plans/week/resume` — pause/resume
  auto-renew, auto-skip, and reminders for travel/illness windows. The active
  week stays intact.
- `POST /plans/week/review-and-apply` — legacy endpoint for user-selected
  recommendations from the weekly check-in; the current weekly review UI does
  not call it.
- `POST /plans/week/checkin-settings` — saves explicit weekly review setup
  changes to `UserPreferences` / `UserGoal`. With user confirmation, it may
  call the deterministic remaining-week paths so only unlocked current/future
  `PlanDay` rows change; completed, skipped, and started days stay locked.
- `PATCH /plans/days/{day_date}/workout` and `…/nutrition` — partial
  per-day patches (used by Change Focus, exercise swaps, and manual edits).
- `POST /plans/days/{day_date}/start` — locks a day when the user begins it.
- `POST /plans/days/{day_date}/complete` / `skip` / `unskip` — status changes
  for the dated `PlanDay`.
- `POST /plans/week/adapt-remaining` — re-fills unlocked future workouts from
  current fatigue while keeping the same weekly recipe.
- `POST /plans/week/repair-injury-conflicts` — safety exception after injury
  changes; rewrites unlocked current/future exercise lists without changing the
  dated week structure.
- `POST /plans/week/repair-equipment-conflicts` — availability exception after
  equipment removal; swaps only incompatible exercises on unlocked
  current/future workouts while preserving the dated week structure, focus,
  rest/training days, and compatible exercises.
- `POST /plans/week/regenerate-remaining` — explicit mid-week settings-change
  path for unlocked future days after days/week or split changes.

## Frontend Loading Flow (`HomeScreen.loadPlans`)

1. On mount + on `userProfile` change, call `getActivePlanWeek(token)`.
2. If `null` → call `startNewPlanWeek(token, false)` to generate one.
3. If `end_date < today` / the returned week needs renewal → call
   `autoRenewPlanWeek(token)` and use
   the returned `plan_week`. `WeeklyCheckinCard` reads
   `/plans/week/checkin-status` separately to show the prior week's review
   window or saved recap.
4. Store the result in `planWeek` state. Project its `days[]` into a
   legacy `WorkoutPlan` shape (`{ name, totalDays, days }`) so the
   existing `WorkoutCard` / `DayCard` rendering keeps working.
5. Render the schedule via `getScheduleFromPlanWeek(planWeek)` — returns
   `ScheduleItem[]` directly from the dated `PlanDay` rows.
6. AsyncStorage cache (`aiWorkoutPlan` / `aiNutritionPlans`) is a
   write-through used **only** when the backend is unreachable.

## What Was Removed

- **Daily fresh-day regeneration** (`freshDayGenerated_${todayKey()}`
  block in `loadPlans`) — single-day regen on every app open is gone.
  The PlanWeek is fixed for the full 7 days.
- **Rolling-from-today schedule** (`get7DaySchedule(workoutPlan, …)` is
  still defined but only used as a legacy fallback when no `PlanWeek`
  exists). The new `getScheduleFromPlanWeek` is the canonical path.
- **`isToday = i === 0`** assumption — replaced with date-based
  comparison (`key === todayKey()`). With the dated PlanWeek model,
  today may be at any index after the first day of the user's own
  7-day cadence.
- **`isCompleted = isToday && todayDone`** — replaced with
  `completedDates.has(key) || (isToday && todayDone)` so any past day's
  completed workout shows as done.

## Scoped Cache Clear (`src/utils/planCacheReset.ts`)

Three functions, each matching a domain by substring pattern:

- `clearWorkoutCache()` — clears `workoutDayState_*` and related keys.
- `clearMealCache()` — clears `mealPlan_*`, `preservedMeal_*`, and related keys.
- `clearAllPlanCache()` — both domains.

`PRESERVED_KEYS` safelist: auth tokens, userProfile, weightEntries,
workoutHistory, themePreference, metaData_v1, metaData_v4.

`applyPlanResult` calls the appropriate clear **before** writing the new
plan, so a workout-only regen doesn't wipe meal state.

## Per-Day Patch Flow (Change Focus, Exercise Swaps, Manual Edits)

1. UI mutates a single day (e.g., user swaps Push → Pull on Wednesday).
2. Client calls `PATCH /plans/days/{day_date}/workout` with the new
   `workout_json`.
3. Backend writes the patch onto the matching `PlanDay`, leaves all
   other days untouched.
4. Client refetches `/plans/week/active` (or applies the response
   directly) to update local state.

The deterministic planner reads `recent_focus_buckets`,
`recent_focus_families`, `muscle_fatigue` so per-day patches respect
adjacency / fatigue. AI plan review is **permanently disabled**
(`PLAN_REVIEW_ENABLED=0` is a no-op); regeneration goes through the
deterministic path only.

## Mid-Week Profile Edits

Goal, equipment, split, duration, and days/week edits update
`UserGoal` / `UserPreferences` immediately, but they do **not** replace the
active `PlanWeek`. The current dated week remains the source of truth until
auto-renew. Equipment removal is a scoped exception: the app may call
`repair-equipment-conflicts` to swap only exercises that require now-unavailable
equipment on today/future unlocked workouts. Adding equipment does not reshuffle
the current week; it is available to Swap flows immediately and normal plan
generation on the next PlanWeek. Session-duration changes are also scoped: the
app may call `update-session-duration` to rebuild only today/future unlocked
workouts against the new time budget and snapshot `PlanWeek.session_minutes`.
The app should only offer immediate current-week changes through explicit user
confirmation. Split, goal, and days/week changes normally wait for the next
generated PlanWeek, unless the user chooses the review/remaining-week
regeneration flow that protects locked days.

## History Plumbing

- `prev_focuses` — raw focus labels from recent completions. Normalized
  to `recent_focus_buckets` (coarse) + `recent_focus_families` (fine:
  push/pull/legs).
- Both feed `generate_weekly_recipe` rotation to avoid back-to-back same
  focus.
- History brief includes `user_preferred_split` + `skipped_days_7d` for
  reviewer context.

## Past-Day Rendering

`DayCard` accepts `isToday`, `isCompleted`, `isSkipped`, and
`completedSummary`. For past days inside the active PlanWeek:

- `isCompleted` comes from `completedDates.has(day_date)` (loaded from
  `WorkoutSession` history at app open).
- `completedSummary` is looked up by date in `workoutHistorySummaries`,
  not from a single `todaySummary` value.
- The day-of-week label resolves to "Yesterday" / "Today" / "Tomorrow"
  for adjacent days, falling back to weekday name otherwise.

## Sign-Up-Day Cadence

`POST /plans/start-new-week` anchors the first PlanWeek on the user's start
date. A user who signs up Saturday gets a Saturday-Friday PlanWeek, with
Saturday highlighted as today and the next renewal scheduled for the following
Saturday. Auto-renew uses `prev.end_date + 1`, so the personal cadence persists
instead of snapping to a calendar Monday.
