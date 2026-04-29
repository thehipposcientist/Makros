# Full Codebase Review — Thallo

Last updated: 2026-04-29

---

## Executive Summary

**Overall health**: The app has a solid feature set with a deterministic workout planner, AI coaching, fatigue tracking, meal planning, injury system, and nutrition scoring. However, the codebase has accumulated significant technical debt from rapid feature development. Most critical issues are around data correctness (wrong formulas, stale state), reliability (silent failures, no error feedback), and performance (N+1 queries, expensive re-renders).

**Biggest risks**:
1. Readiness score recalculated with wrong formula in 3 places — produces incorrect recovery data
2. Historical item resolved: model defaults no longer point at a broken scan path
3. Silent data loss on AsyncStorage failures — users lose workout logs and meal edits with no warning
4. CORS wildcard with credentials — security + functionality issue for production
5. Nutrition averages computed over logged days only — inflates intake for inconsistent trackers

**Biggest quick wins**:
1. Fix readiness formula mismatches (copy from canonical source)
2. Keep model-routing docs in sync with the current scan defaults
3. Add `useMemo` to NutritionCard and WorkoutCard
4. Fix rolling average denominator
5. Remove dead code / stale aliases

**Biggest product opportunities**:
1. Gender-aware fitness scoring (currently male-calibrated, demotivating for women)
2. Recovery bonus is too slow to feel meaningful — users won't see the effect
3. Allergen filter needs word-boundary matching to avoid false positives (egg→eggplant)

---

## Critical Issues

### C1. Resolved: scan-model defaults are no longer broken
**Category:** AI Integration | **Files:** `backend/app/routers/ai/utils.py:49`
This issue was fixed after the original review. Current defaults are `MODEL_MEAL_PARSING=gpt-4o-mini` for text parsing/search and `MODEL_IMAGE=gpt-5.4-mini` for dedicated image-analysis routes, so fresh deploys no longer inherit the broken `gpt-5-mini` parsing default described in the original snapshot.
**Follow-up:** Keep deployment/setup docs aligned with the current model-routing split so future env changes do not reintroduce drift.

### C2. Readiness Score Recalculated With Wrong Formula (3 locations)
**Category:** Bug | **Files:** `workouts.py:321`, `workouts.py:775`, `workouts.py:704`
The canonical readiness formula in `activity_impact.py:344` is:
```python
overall = 1.0 - (muscle_avg * 0.6 + systemic * 0.4)  # where muscle_avg = sum(10 muscles) / 10
```
But inline recalculations after injury boost and nutrition bonus use:
```python
avg = sum(7 muscles) / 7  # wrong count, wrong muscles
score = (1 - avg) * 100   # missing 0.6/0.4 weighting, missing systemic
```
This produces optimistic scores when it should produce pessimistic ones (injury/low-protein scenarios).
**Fix:** Extract the formula to a shared function in `activity_impact.py` and call it everywhere. Never inline this calculation.

### C3. CORS Wildcard + Credentials = Non-Functional
**Category:** Security | **Files:** `backend/app/main.py:14-16`
`allow_origins=["*"]` with `allow_credentials=True` is rejected by browsers per CORS spec. Credentialed cross-origin requests silently fail.
**Fix:** Set specific allowed origins for production.

---

## High Priority Issues

### H1. Rolling Nutrition Averages Divide by Logged Days, Not Window
**Category:** Logic Error | **Files:** `meal_history.py:211`
`avg_calories = total / days_with_data` instead of `total / window_days`. A user logging 3 of 7 days gets inflated averages. This feeds into the AI context and the Health Score.
**Fix:** Divide by window days for "daily average", or clearly label as "average on logged days."

### H2. Strength Mode Not in `pick_split` Condition
**Category:** Bug | **Files:** `planner.py:1131-1134`
`planner_mode="strength"` is not in the list `("lifting", "fat_loss_mix", "lifting_plus_cardio")`, so `pick_split` never runs for strength users and `lifting_split` is always `None`.
**Fix:** Add `"strength"` to the condition, or document that strength mode bypasses split selection.

### H3. Silent AsyncStorage Write Failures
**Category:** UX/Reliability | **Files:** Multiple (`mealTracker.ts`, `workoutHistory.ts`, `HomeScreen.tsx`)
Every save to AsyncStorage has `catch {}`. If storage is full or corrupted, data is silently lost. User sees success UI but workout/meal data wasn't saved.
**Fix:** Add error toast for user-facing saves. Log all failures to telemetry.

### H4. `goal_type` Dependency in ProgressScreen (Should Be `goal`)
**Category:** State Bug | **Files:** `ProgressScreen.tsx:184`
Effect depends on `userProfile?.goal_type` which is always `undefined` — the field is `userProfile.goal`. Nutrition score never recalculates on goal change.
**Fix:** Change to `userProfile?.goal`.

### H5. Production API URL is Placeholder
**Category:** Deployment | **Files:** `api.ts:15`
`'https://your-production-api.com'` — production builds will fail on every API call.
**Fix:** Inject via environment variable.

### H6. Allergen Filter Substring Matching Causes False Positives
**Category:** Nutrition Safety | **Files:** `allergen_filter.py:47-53`
`"egg"` matches `"eggplant"`, `"soy"` matches `"savory"`. Food items are incorrectly removed.
**Fix:** Use word-boundary regex matching.

### H7. Fitness Score Gender-Blind — Penalizes Female Users
**Category:** Product | **Files:** `fitness_score.py:52-53`
Strength standards use male intermediate benchmarks. Women performing at correct female standards score ~30% lower. Systematically demotivating for half the user base.
**Fix:** Add gender parameter and apply correction factor, or use gender-neutral percentile norms.

### H8. `get_common_meals` No Date Limit — Full Table Scan
**Category:** Performance | **Files:** `meal_history.py:235`
Loads ALL meals for user with no date filter. 2+ years = full table scan into memory.
**Fix:** Add 90-day window and pagination.

### H9. `list_meals` Unbounded Without Date Filter
**Category:** Performance/API | **Files:** `meals.py:126`
No pagination, no default date range when `meal_date` is omitted. Large payload for long-term users.
**Fix:** Add default limit (50) and pagination.

---

## Medium Priority Issues

### M1. Recovery Bonus Too Slow to Feel Meaningful
**Category:** Product | **Files:** `activity_impact.py:337-340`
Recovery removes `min(0.15, current * 0.15) * decay`. After decay, effective removal is 1-5% per session. A user doing daily yoga after a hard leg day needs ~13 sessions to clear moderate soreness. Real active recovery restores meaningful readiness in 24-48h.
**Fix:** Remove decay multiplier from recovery pass, or increase base rate to 25%.

### M2. `NutritionCard` Recomputes Score Every Render
**Category:** Performance | **Files:** `NutritionCard.tsx:53`
`computeNutritionScore` iterates all meals, classifies every food via keywords. Runs on every parent re-render.
**Fix:** Wrap in `useMemo([nutritionPlan, goal])`.

### M3. `WorkoutCard` Duration Estimate Recalculated Every Render
**Category:** Performance | **Files:** `WorkoutCard.tsx:95-114`
Regex parsing per exercise on every render, for every day in the 7-day schedule.
**Fix:** Wrap in `useMemo([workout.exercises])`.

### M4. Pre-Set Hint Effect Fires on Every Set Log
**Category:** Performance | **Files:** `ActiveWorkoutScreen.tsx:471-515`
`exercises` dep is a new reference every set log. Effect re-runs unnecessarily.
**Fix:** Replace dep with `exercises[activeExIdx]?.sets.length`.

### M5. Injury Fatigue Boost Uses Dead Variable + Accumulates
**Category:** Bug | **Files:** `workouts.py:315`
`current` assigned but never used. Boost accumulates on every `/generate-day` call with no ceiling.
**Fix:** Either gate the add on current value or remove the variable.

### M6. `focus_override` Bypasses Swap But Not Set Reduction
**Category:** Bug | **Files:** `workouts.py:416,465`
User overrides to "Legs" on fatigued day → swap is skipped (correct) but sets are silently reduced (confusing). No explanation shown to user.
**Fix:** Skip set reduction or show a fatigue warning when override is active.

### M7. Hydration Bonus Always 0
**Category:** Product | **Files:** `nutrition_score.py:221`
`hydration_logged` defaults to `False` and no caller ever sets it from real data. The 10-point quality bonus is silently suppressed for all users.
**Fix:** Either remove hydration from scoring until tracking exists, or tie it to water recommendation acknowledgment.

### M8. MealEditModal Reseeds on Prop Identity Change
**Category:** State Bug | **Files:** `MealEditModal.tsx:259-270`
Effect resets items when `meal` object identity changes (common during parent re-renders). User loses in-progress edits silently.
**Fix:** Gate reset on `visible` transitioning `false→true` only.

### M9. `MIN_SAFE_CALORIES` Constant vs Inline Floor Inconsistency
**Category:** Architecture | **Files:** `goal_params.py:45` vs `calorie_calculator.py:594`
Constant says 1200, actual floor is gender-aware (1200/1500). Constant is unused dead code.
**Fix:** Remove constant or make it a function that accepts gender.

### M10. Reference Ranges Don't Apply Safety Floor
**Category:** Nutrition | **Files:** `calorie_calculator.py:685`
Cut calories in the reference card can go below 1200 for small female users. UI shows this as a valid option.
**Fix:** Apply `max(min_floor, cals)` in reference range calculation.

---

## Low Priority / Cleanup

### L1. Dead Aliases — `nutritionChat` / `setNutritionChat`
**Files:** `HomeScreen.tsx:1158-1159`
Point to workoutChat after unified chat refactor. Should be removed to avoid confusion.

### L2. `focused_muscle` Deprecated But Active in Scoring Stack
**Files:** `planner.py:76`, `score_candidate`, `weekly_set_targets`, `prescribe_sets_reps`
Can stack with `priority_region` in undocumented ways.

### L3. Dead Code — `_validate_plans_legacy`
**Files:** `plans.py:39`
Never called. Maintenance risk during refactors.

### L4. Endurance Advanced/Intermediate Volume Targets Identical
**Files:** `planner.py:206-210`
Byte-for-byte same values. Either intentional (document) or missing differentiation.

### L5. Fitness Score `data_quality` Unreachable Branch
**Files:** `fitness_score.py:282-284`
Both branches of ternary return `"partial"`. `"missing"` case unreachable.

### L6. `shareLoading` Never Reset on Early Return
**Files:** `ProgressScreen.tsx:203-222`
If capture ref is null, share button stays disabled forever.
**Fix:** Add `try/finally`.

### L7. Startup Enrichment Hardcodes `/app` Path
**Files:** `main.py:99`
Breaks outside Docker container.

### L8. `print()` Debug Statements Still in Production Paths
**Files:** `history.py:233,242`, `workouts.py:262,394,399`
Bypasses logging framework, synchronous stdout I/O.

---

## Suggested Next 10 Fixes (Priority Order)

| # | Issue | Effort | Impact |
|---|---|---|---|
| 1 | Fix readiness formula mismatches (C2) | 30 min | Critical — wrong recovery data |
| 2 | Fix model ID default (C1) | 1 min | Critical — food scanning breaks |
| 3 | Fix rolling average denominator (H1) | 10 min | High — inflated nutrition data |
| 4 | Fix `goal_type` dep in ProgressScreen (H4) | 1 min | High — stale score |
| 5 | Add `useMemo` to NutritionCard + WorkoutCard (M2, M3) | 15 min | Medium — perf on every render |
| 6 | Fix allergen substring matching (H6) | 20 min | High — food safety |
| 7 | CORS configuration (C3) | 5 min | Critical for production |
| 8 | Add meal list pagination (H9) | 20 min | High — unbounded query |
| 9 | Fix injury boost accumulation (M5) | 10 min | Medium — wrong fatigue |
| 10 | Remove dead aliases + code (L1-L3) | 15 min | Low — code clarity |
