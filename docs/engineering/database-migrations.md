# Database Migrations

Last updated: 2026-05-24

## Pattern

SQLModel `create_all` creates tables but does NOT ALTER existing columns. Idempotent `ADD COLUMN IF NOT EXISTS` helpers live in `backend/app/database.py` and run on every startup.

**Rule**: Never use Alembic or raw SQL migration files in this project. Always add a new idempotent `_ensure_*` helper function to `database.py`.

Startup is for schema readiness only. Data scans and seed refreshes are default-off unless `STARTUP_DATA_MAINTENANCE_ENABLED=1`, and startup backfills additionally require `STARTUP_BACKFILLS_ENABLED=1`; prefer `python -m app.maintenance_jobs --all` / `make maintenance`. OpenAI enrichment and historical AI backfills are not wired into startup.

## Existing Migration Helpers

| Function | What it adds |
|---|---|
| `_ensure_food_category_enum_values` | Food category enum extension. |
| `_ensure_food_nutrition_extras_column` | `FoodNutrition.extra_nutrients` JSONB. |
| `_ensure_user_recovery_columns` | `recovery_question` + `recovery_answer_hash`. |
| `_ensure_user_subscription_tier_column` | `User.subscription_tier`, subscription lifecycle fields, signup-trial timestamps, RevenueCat identifiers, and related indexes; existing-user Pro backfill only runs when `BETA_BACKFILL_EXISTING_USERS_TO_PRO=1`. |
| `_ensure_user_oauth_columns` | `User.apple_sub` plus a unique non-null index for Sign in with Apple account links. |
| `_ensure_workout_completion_stimulus_column` | Stimulus tracking on completions. |
| `_ensure_workout_completion_health_columns` | Health signals on completions. |
| `_ensure_workout_completion_training_score_columns` | Persisted workout training score, rating, and score breakdown on completions. |
| `_ensure_workout_history_source_columns` | Completion source metadata, structured session external ids, plus custom exercise muscle/slug snapshots for history rollups. |
| `_ensure_user_preferences_equipment_settings_column` | `UserPreferences.equipment_settings` JSONB for plate/dumbbell loading constraints. |
| `_ensure_user_preferences_custom_macros_column` | `UserPreferences.custom_macros` JSONB for durable user-set nutrition targets. |
| `_ensure_user_supplement_stack_group_column` | `UserSupplementStack.group_label` plus a per-user group index for supplement batches. |
| `_ensure_user_supplement_stack_ai_metadata_columns` | `UserSupplementStack.description`, `effectiveness_confidence`, and `source_terms` for supplement purpose/effectiveness/source-image metadata. |
| `_ensure_coach_apply_state_columns` | Durable coach-apply settings: workout duration, core frequency, preferred split, preference-level injury flags, deload date, global/muscle volume adjustments, intensity adjustment, and one-day macro overrides. |
| `_ensure_exercise_tracking_mode_column` | `Exercise.default_tracking_mode`. |
| `_ensure_food_metadata_classifier_v2_columns` | `protein_source` + `probiotic_flag` on `FoodMetadata`. |
| `_ensure_daily_nutrition_metrics_v2_columns` | `plant_protein_g`, `animal_protein_g`, `probiotic_servings` on `DailyNutritionMetrics`. |
| `_ensure_nutrition_v3_columns` | `FoodNutrition.added_sugar_g` + `FoodMetadata` v3 flags (seafood/fruit/vegetable/alcohol/processed_meat/refined_grain) + `DailyNutritionMetrics` tag servings + `recovery_flags` JSONB + `energy_availability` + `max_meal_protein_pct`. |
| `_ensure_nutrition_log_status_columns` | Explicit nutrition-day completeness on `UserDayState` plus rollup snapshots on `DailyRollup` (`nutrition_log_status`, confidence, indexes). |
| `_ensure_social_tables` | `friendships` canonical pair index + `weekly_digest_cache` per-user-per-week index + `feed_likes` uniqueness + `feed_comments` item/date index + `social_notifications` actor/subject dedupe and inbox indexes. Tables built by `create_all`; this helper guarantees the indexes on legacy DBs. |
| `_ensure_trainer_tables` | Trainer profile/client relationship/notes indexes: unique trainer-client pair, trainer/client status lookups, and relationship-note chronology. Tables built by `create_all`; this helper guarantees indexes on legacy DBs. |
| `_ensure_exercise_set_actual_rir_column` | `ExerciseSet.actual_rir DOUBLE PRECISION`. |
| `_ensure_daily_health_snapshot_table` | Daily health snapshot unique index plus `basal_energy_kcal` and `source_details` for Apple Health / Health Connect / direct-provider provenance. |
| `_ensure_daily_stress_summary_table` | Daily Stress summary uniqueness/indexes for persisted daily average, peak, latest, and source counts. |
| `_ensure_skip_reason_columns` | `UserDayState.skip_reason` + `PlanDay.skip_reason` for manual skips. |
| `_ensure_body_scan_quality_columns` | Body-scan estimate provenance: confidence, photo quality, retake flag, method, visual/measurement estimates, and quality flags. |
| `_ensure_meal_saved_meal_link_column` | `Meal.saved_meal_id` nullable link so favorite renames can propagate across logged meal names without changing nutrition snapshots. |
| `_ensure_meal_client_key_column` | `Meal.client_meal_key` nullable client slot key (`meal_4`, etc.) so plan-check rows with 5+ meals/day stay distinct even when their coarse `MealType` is `snack`. |
| `_ensure_meal_delete_constraints` | `meal_items.meal_id` cascades on meal delete and `meals.saved_meal_id` nulls on saved-meal delete. |
| `_ensure_meal_routine_display_order_column` | `MealRoutine.display_order` plus a per-user order index so routine meal ordering is account-wide instead of day-local. |
| `_backfill_user_preferences_preferred_split` | Fills missing `UserPreferences.preferred_split` from synced `user_state.userProfile.preferredSplit`, then explicit `PlanWeek.preferred_split`; does not infer from day labels. |
| `_ensure_meal_item_nutrient_snapshot_columns` | Optional serving-level nutrient snapshots on `meal_items` (`fiber_g`, `sodium_mg`, `saturated_fat_g`, `sugar_g`, etc.) so imports/scans preserve quality metrics without a canonical food link. |
| `_ensure_user_custom_exercises_table` | Creates `user_custom_exercises`, a user-scoped exercise library for manual/AI/photo-scan exercises lifted out of the opaque user-state blob, plus display/search metadata such as `programming_tags`. |
| `_backfill_custom_food_micronutrients` | Explicit maintenance backfill; no longer runs on default startup. |
| `_ensure_sun_exposure_tables` | Creates sun exposure segment/correction tables and keeps legacy segment rows current with `light_intensity_lux`, local timing buckets (`local_start_minute`, `local_end_minute`), and `timezone_offset_minutes`. |

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

## Food Submissions Table

Created via `SQLModel.create_all` (new table; no `ADD COLUMN` helper needed).

- **`food_submissions`** — pending user-submitted foods for catalog review.
  The submitted item is immediately available as a private `foods` row, while
  this table keeps review status, barcode/brand, serving, macros, micros,
  aliases, photo URLs, raw payload, and optional linked global food id.

## AI Usage Events Table

Created via `SQLModel.create_all` (new table; no `ADD COLUMN` helper needed).

- **`ai_usage_events`** — best-effort OpenAI accounting rows. Columns:
  `id`, `user_id`, `route`, `budget_bucket`, `model`, `success`,
  `image_count`, `prompt_tokens`, `completion_tokens`, `total_tokens`,
  `estimated_cost_usd`, `latency_ms`, `error_type`, `created_at`.

## Legal Acceptance Events Table

Created via `SQLModel.create_all` (new table; no `ADD COLUMN` helper needed).

- **`legal_acceptance_events`** — versioned audit trail for legal acceptance.
  Columns: `id`, `user_id`, `legal_version`, `source`,
  `accepted_terms`, `accepted_privacy`, `accepted_health_disclaimer`,
  `accepted_ai_disclaimer`, `client_ip`, `user_agent`, `accepted_at`.
  Current accepted versions still live on the `user` row for fast auth/profile
  checks; this table preserves history until account deletion.

## Health Lab Results Table

Created via `SQLModel.create_all` (new table; no `ADD COLUMN` helper needed).

- **`health_lab_results`** — optional user-confirmed lab markers imported from
  manual entry or reviewed scan candidates. Columns: `id`, `user_id`,
  `lab_type`, `value`, `unit`, `collected_at`, `source`,
  `reference_range_low`, `reference_range_high`, `created_at`. Raw lab report
  files are not stored.

## Daily Stress Summaries Table

Created via `SQLModel.create_all` (new table); `_ensure_daily_stress_summary_table`
guarantees uniqueness/indexes on legacy databases.

- **`daily_stress_summaries`** — one modeled Daily Stress aggregate per user per
  day. Columns: `id`, `user_id`, `summary_date`, `avg_stress`, `max_stress`,
  `latest_stress`, `sample_count`, `source_count`, `source`, `source_details`,
  `computed_at`, `created_at`, `updated_at`. Used for personal-baseline
  comparisons only; it is not a PlanWeek mutation input.

## Trainer Tables

Created via `SQLModel.create_all` (new tables); `_ensure_trainer_tables`
guarantees uniqueness/indexes on legacy databases.

- **`trainer_profiles`** — optional trainer identity for a user account:
  display name, business name, bio/contact fields, accepting-clients flag.
- **`trainer_client_relationships`** — explicit-consent trainer/client rows.
  One row per `(trainer_user_id, client_user_id)` with `pending` / `active` /
  `declined` / `revoked` status plus per-client sharing flags for workouts,
  nutrition, body metrics, and recovery.
- **`trainer_client_notes`** — trainer-authored client notes scoped to an
  active relationship. Notes are included in account export and deleted when
  either side deletes their account.

## Watch Cellular Tables

Created via `SQLModel.create_all` (new tables); `_ensure_watch_device_tables`
guarantees hot-path indexes on legacy databases.

- **`watch_devices`** — limited watch API credentials linked to a user/device id.
  Tokens are stored as hashes and invalidated when `User.token_version` bumps.
- **`watch_command_events`** — idempotency/audit rows for direct watch commands
  sent over Wi-Fi/cellular. Initial supported command: `log_hydration`.

## Adding a New Migration

1. Add `def _ensure_my_new_column()` to `database.py` with an `ADD COLUMN IF NOT EXISTS` statement.
2. Call it inside `create_db_and_tables()` after related existing calls.
3. Also add the column to the `SQLModel` class in `models.py` with `Optional[type] = None`.
4. Test by restarting the backend with a running DB — no errors = migration idempotent.
