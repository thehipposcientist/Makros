# Backlog Review — Contradictions & Stale Notes

Last reviewed: 2026-04-28

Items where the old CLAUDE.md had conflicting or ambiguous information. Verify current code state before acting.

---

## 1. actual_rir + Rolling e1RM — Partially shipped

**Topic**: `ExerciseSet.actual_rir` column and `rolling_e1rm.py` helper.

**Conflicting notes**:
- Implementation section (former CLAUDE.md §"actual_rir + Rolling e1RM") describes the column, migration `_ensure_exercise_set_actual_rir_column`, and `compute_rolling_e1rm` helper as fully implemented, with tests in `tests.test_rolling_e1rm`.
- Roadmap "Future feature wins" listed "Actual RIR persistence" and "Rolling e1RM" as not yet shipped.

**Why it's likely stale**: The implementation section is detailed and specific (file paths, function signatures, math), and `tests.test_rolling_e1rm` confirms the helper is tested. The roadmap entry was not updated when the backend was written.

**Recommended follow-up**: The DB column and computation helper are shipped. What's missing is **UI capture** — the log-set screen doesn't yet collect actual RIR from the user. Roadmap should say "wire actual_rir input to log-set UI" not "add the column."

---

## 2. Watch Active-State Persistence — Likely shipped

**Topic**: `ActiveWorkoutState` persistence to UserDefaults in the watch app.

**Conflicting notes**:
- Implementation section (#148) describes `targets/thallo-watch/ActiveWorkoutView.swift::ActiveWorkoutState` as fully implemented with `persist()`, `hydrate()`, `clearPersisted()`.
- Roadmap listed "Watch active-state persistence" as not yet shipped.

**Why it's likely stale**: The implementation section includes exact file paths, function names, and the hydrate guard pattern — level of detail inconsistent with aspirational notes. The `#148` issue number suggests it was a tracked ticket that was closed.

**Recommended follow-up**: Verify `ActiveWorkoutState` and `hydrate()` exist in `targets/thallo-watch/ActiveWorkoutView.swift`. If so, remove from roadmap.

---

## 3. "Tests to add" section — Partially stale

**Topic**: The "Tests to add" bullet list in the former CLAUDE.md.

**Conflicting notes**:
- "Recommended Next Improvements > Tests to add" listed `weekly_volume._classify` and `quick_intents.match_intent` for all 12 patterns as not yet written.
- Test Suite section listed `tests.test_weekly_volume` and `tests.test_quick_intents` as already added (with specific test descriptions).

**Why it's stale**: The test suite section is clearly describing implemented tests; the "tests to add" section wasn't pruned when those tests were written.

**Recommended follow-up**: Remaining genuinely unwritten tests are `plan_review_v2._build_headline`, `carb_distribution`, AI estimator regression, plan review snapshot, and Watch payload schema. These are now in `docs/engineering/test-suite.md`.

---

## 4. "Switch Day" label — Renamed

**Topic**: UI label for the day-focus picker.

**Conflicting notes**:
- UI Layout section referenced "Switch Day picker (allow-with-warnings)".
- Apr 2026 work renamed the button and picker header to "Change Focus".

**Why it's stale**: The rename was made in `src/screens/HomeScreen.tsx` but the doc wasn't updated.

**Recommended follow-up**: `docs/product/ui-layout.md` now uses "Change Focus picker." No action needed unless you find other "Switch Day" references in client code that weren't renamed.

---

## 5. Home Trainer model string

**Topic**: Model name referenced in the AI coach description.

**Conflicting notes**:
- CLAUDE.md said: `"Model: MODEL_CHAT (gpt-4o-mini or gpt-5)"`.
- `backend/.env` example only shows `MODEL_CHAT=gpt-4o-mini`.
- `gpt-5` is not a real OpenAI model name as of the last knowledge cutoff.

**Why it's suspect**: Looks like an aspirational placeholder (`gpt-5`) that was added speculatively. The actual runtime model is whatever `MODEL_CHAT` is set to in `.env`.

**Recommended follow-up**: Verify the actual MODEL_CHAT value in your `.env`. The architecture doc now just says "env var, default gpt-4o-mini" without the `gpt-5` reference.

---

## 6. Cycling-array `WorkoutPlan.days` — Now legacy

**Topic**: The "weekly workout plan" data shape used by `HomeScreen`.

**Conflicting notes**:
- Older docs described a 3-7 day `WorkoutPlan.days[]` cycling array
  indexed by `completedDates.size % totalDays` (the rolling-from-today
  schedule produced by `get7DaySchedule`).
- As of 2026-04-28 the front-page schedule comes from a fixed dated
  `PlanWeek` with 7 `PlanDay` rows, and the daily fresh-day regen on
  app open has been removed.

**Why this matters**: New code should consume the `PlanWeek` model
(`getActivePlanWeek` / `startNewPlanWeek` / `autoRenewPlanWeek` from
`services/api.ts`) — not pretend `WorkoutPlan.days[]` is still rolled
through `% totalDays`. The legacy `get7DaySchedule` is retained only as
a fallback when no PlanWeek exists.

**Recommended follow-up**: Once telemetry shows zero callers using the
legacy fallback, retire `get7DaySchedule` and the
`POST /workouts/generate-day` API client. Migrate Switch Day to call
`PATCH /plans/days/{day_date}/workout` instead of the legacy week
regen path.
