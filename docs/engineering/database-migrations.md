# Database Migrations

Last synced from CLAUDE.md: 2026-04-27

## Pattern

SQLModel `create_all` creates tables but does NOT ALTER existing columns. Idempotent `ADD COLUMN IF NOT EXISTS` helpers live in `backend/app/database.py` and run on every startup.

**Rule**: Never use Alembic or raw SQL migration files. Always add a new `_ensure_*` helper function to `database.py`.

## Existing Migration Helpers

| Function | What it adds |
|---|---|
| `_ensure_food_category_enum_values` | Food category enum extension. |
| `_ensure_food_nutrition_extras_column` | `FoodNutrition.extra_nutrients` JSONB. |
| `_ensure_user_recovery_columns` | `recovery_question` + `recovery_answer_hash`. |
| `_ensure_workout_completion_stimulus_column` | Stimulus tracking on completions. |
| `_ensure_workout_completion_health_columns` | Health signals on completions. |
| `_ensure_exercise_tracking_mode_column` | `Exercise.default_tracking_mode`. |
| `_ensure_food_metadata_classifier_v2_columns` | `protein_source` + `probiotic_flag` on `FoodMetadata`. |
| `_ensure_daily_nutrition_metrics_v2_columns` | `plant_protein_g`, `animal_protein_g`, `probiotic_servings` on `DailyNutritionMetrics`. |
| `_ensure_nutrition_v3_columns` | `FoodNutrition.added_sugar_g` + `FoodMetadata` v3 flags (seafood/fruit/vegetable/alcohol/processed_meat/refined_grain) + `DailyNutritionMetrics` tag servings + `recovery_flags` JSONB + `energy_availability` + `max_meal_protein_pct`. |
| `_ensure_social_tables` | `friendships` canonical pair index + `weekly_digest_cache` per-user-per-week index. Tables built by `create_all`; this helper guarantees the indexes on legacy DBs. |
| `_ensure_exercise_set_actual_rir_column` | `ExerciseSet.actual_rir DOUBLE PRECISION`. |
| `_backfill_custom_food_micronutrients` | One-shot backfill on startup. |

## Adding a New Migration

1. Add `async def _ensure_my_new_column(engine)` to `database.py` with an `ADD COLUMN IF NOT EXISTS` statement.
2. Call it inside `run_startup_migrations()` after the existing calls.
3. Also add the column to the `SQLModel` class in `models.py` with `Optional[type] = None`.
4. Test by restarting the backend with a running DB — no errors = migration idempotent.
