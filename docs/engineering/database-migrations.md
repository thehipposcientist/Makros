# Database Migrations

Last updated: 2026-04-30

## Pattern

SQLModel `create_all` creates tables but does NOT ALTER existing columns. Idempotent `ADD COLUMN IF NOT EXISTS` helpers live in `backend/app/database.py` and run on every startup.

**Rule**: Never use Alembic or raw SQL migration files. Always add a new `_ensure_*` helper function to `database.py`.

## Existing Migration Helpers

| Function | What it adds |
|---|---|
| `_ensure_food_category_enum_values` | Food category enum extension. |
| `_ensure_food_nutrition_extras_column` | `FoodNutrition.extra_nutrients` JSONB. |
| `_ensure_user_recovery_columns` | `recovery_question` + `recovery_answer_hash`. |
| `_ensure_user_subscription_tier_column` | `User.subscription_tier` plus one-shot existing-user Pro backfill marker in `app_migrations`. |
| `_ensure_workout_completion_stimulus_column` | Stimulus tracking on completions. |
| `_ensure_workout_completion_health_columns` | Health signals on completions. |
| `_ensure_user_preferences_equipment_settings_column` | `UserPreferences.equipment_settings` JSONB for plate/dumbbell loading constraints. |
| `_ensure_coach_apply_state_columns` | Durable coach-apply settings: workout duration, core frequency, preference-level injury flags, deload date, and one-day macro overrides. |
| `_ensure_exercise_tracking_mode_column` | `Exercise.default_tracking_mode`. |
| `_ensure_food_metadata_classifier_v2_columns` | `protein_source` + `probiotic_flag` on `FoodMetadata`. |
| `_ensure_daily_nutrition_metrics_v2_columns` | `plant_protein_g`, `animal_protein_g`, `probiotic_servings` on `DailyNutritionMetrics`. |
| `_ensure_nutrition_v3_columns` | `FoodNutrition.added_sugar_g` + `FoodMetadata` v3 flags (seafood/fruit/vegetable/alcohol/processed_meat/refined_grain) + `DailyNutritionMetrics` tag servings + `recovery_flags` JSONB + `energy_availability` + `max_meal_protein_pct`. |
| `_ensure_social_tables` | `friendships` canonical pair index + `weekly_digest_cache` per-user-per-week index. Tables built by `create_all`; this helper guarantees the indexes on legacy DBs. |
| `_ensure_exercise_set_actual_rir_column` | `ExerciseSet.actual_rir DOUBLE PRECISION`. |
| `_ensure_skip_reason_columns` | `UserDayState.skip_reason` + `PlanDay.skip_reason` for manual skips. |
| `_backfill_custom_food_micronutrients` | One-shot backfill on startup. |

## PlanWeek + PlanDay Tables

Created via `SQLModel.create_all` (no `ADD COLUMN` migration needed —
they were introduced as new tables).

- **`plan_weeks`** — one active row per user. Columns: `id`, `user_id`,
  `start_date`, `end_date`, `status` (`active` | `expired`),
  `planner_version`, `goal`, `days_per_week`, `preferred_split`,
  `training_day_pattern` (JSONB list), `created_at`.
- **`plan_days`** — 7 rows per `plan_weeks.id`. Columns: `id`,
  `plan_week_id` (FK, indexed), `day_index` (0-6), `day_date` (indexed),
  `status` (`pending` | `in_progress` | `completed` | `skipped`),
  `is_rest`, `locked`, `lock_reason`, `workout_json`, `nutrition_json`,
  `generation_source`.

Lifecycle managed by `backend/app/services/workout/week_manager.py`:
`create_plan_week` / `get_active_week` / `get_week_days` / `lock_day` /
`complete_day` / `skip_day` / `patch_day_workout` / `patch_day_nutrition`
/ `auto_renew_week` / `week_needs_renewal`.

## Adding a New Migration

1. Add `async def _ensure_my_new_column(engine)` to `database.py` with an `ADD COLUMN IF NOT EXISTS` statement.
2. Call it inside `run_startup_migrations()` after the existing calls.
3. Also add the column to the `SQLModel` class in `models.py` with `Optional[type] = None`.
4. Test by restarting the backend with a running DB — no errors = migration idempotent.
