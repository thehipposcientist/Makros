# Plan Persistence + Cache — Architecture

Last updated: 2026-04-28

## Source of Truth: PlanWeek

The front-page schedule is driven by **`PlanWeek` + 7 `PlanDay` rows**, one
active set per user. Each `PlanWeek` carries `start_date`, `end_date`,
`status`, and `planner_version`; each `PlanDay` carries `day_date`, `status`
(`pending` / `in_progress` / `completed` / `skipped`), `is_rest`, `locked`,
`workout_json`, and `nutrition_json`. The 7 days are generated once at week
start and **never regenerated mid-week** — past days accumulate as done /
skipped, today is highlighted, future days remain queued. A new `PlanWeek`
is only generated when the previous one's `end_date < today` (auto-renew).

The legacy `WorkoutPlan` + `NutritionPlan` tables remain for the AI plan
artifact / nutrition templates, but the front-page rendering no longer
indexes into them via a cycling array.

## Endpoints

- `GET /plans/week/active` — returns the active `PlanWeek` (with all 7
  `PlanDay` rows), or `null` if the user has none yet. Response includes
  `needs_new_week: bool` so the client can decide whether to call
  auto-renew.
- `POST /plans/start-new-week` — generates a fresh 7-day plan anchored on
  the most recent **Monday**. Used for first-run setup. Runs the
  deterministic workout planner + nutrition assembler, then persists into
  `plan_weeks` + `plan_days`.
- `POST /plans/week/auto-renew` — when the active week's `end_date` has
  passed, generates the next 7 days immediately. It also snapshots the
  expired week into `plan_week_checkins` so the user has one day to review
  the coach summary and apply durable setting changes for future generated
  weeks. If the user ignores it, the generated week stays as-is and the
  recap remains readable.
  Idempotent: a no-op while the current week is still active.
- `POST /plans/week/review-and-apply` — applies user-selected
  recommendations from the weekly check-in to durable settings; it does not
  rewrite the active `PlanWeek`.
- `PATCH /plans/days/{day_date}/workout` and `…/nutrition` — partial
  per-day patches (used by Change Focus, exercise swaps, and manual edits).
- `POST /plans/days/{day_date}/lock` — pins a single day so subsequent
  regens leave it untouched.

## Frontend Loading Flow (`HomeScreen.loadPlans`)

1. On mount + on `userProfile` change, call `getActivePlanWeek(token)`.
2. If `null` → call `startNewPlanWeek(token, false)` to generate one.
3. If `needs_new_week === true` → call `autoRenewPlanWeek(token)` and use
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
  today may be at any index (e.g., index 1 if the week started Monday
  and today is Tuesday).
- **`isCompleted = isToday && todayDone`** — replaced with
  `completedDates.has(key) || (isToday && todayDone)` so any past day's
  completed workout shows as done.

## Scoped Cache Clear (`src/utils/planCacheReset.ts`)

Three functions, each matching a domain by substring pattern:

- `clearWorkoutCache()` — clears `workoutDayState_*` and related keys.
- `clearMealCache()` — clears `mealPlan_*`, `preservedMeal_*`, and related keys.
- `clearAllPlanCache()` — both domains.

`PRESERVED_KEYS` safelist: auth tokens, userProfile, weightEntries,
workoutHistory, themePreference, metaData_v1.

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
auto-renew. If the user wants an immediate workout change, use the explicit
per-day Change Focus / Swap flows, which patch only unlocked current/future
`PlanDay` rows.

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

## Saturday-Signup Edge Case

`POST /plans/start-new-week` anchors on the most recent **Monday**.
A user who signs up Saturday gets a Mon-Sun week where Mon-Fri render
as past dates with no plan / no history (informational empty cells),
Sat = today (highlighted), Sun = tomorrow. On Monday a fresh full
week generates via auto-renew. This is the trade-off for keeping past
completions visible inside the active week.
