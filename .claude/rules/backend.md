# Claude Rules — Backend

When editing `backend/`:

1. **Migrations**: Always use idempotent `ADD COLUMN IF NOT EXISTS` helpers in `database.py`. Never use Alembic or raw SQL files. See `docs/engineering/database-migrations.md`.

2. **Exercise dict schema**: Use `build_planner_exercise` (in `planner.py`) as the canonical helper for producing exercise dicts. All code paths — planner, AI regenerate, patch rehydration — must go through it.

3. **Plan generation inputs**: All three entry points (single-day, full regen, change-focus) must pass the same shape of inputs: `recent_focus_buckets`, `recent_focus_families`, `muscle_fatigue`. See `docs/architecture/plan-persistence.md`.

4. **AI plan review is dead**: Do not re-enable or call `plan_review.py` / `plan_ai_regenerate.py`. They are permanently disabled.

5. **API response changes**: When adding or changing a field in any response, update `src/services/api.ts` TypeScript types and all screen consumers that read those fields.

6. **Nutrition metrics**: Every meal-write path must call `_refresh_daily_metrics`. Routes: `POST /meals`, `DELETE /meals/{id}`, `POST /meals/log-checked`, and the `handleMealSave` added-meal path.

7. **Tests**: Run `make test` after changes. Register new test modules in `tests/run_all.py`. 21 pre-existing failures are the expected baseline.

8. **Seeding**: Exercise + food seeds run on startup via `seed_exercises_data.py` / `seed_foods_data.py`. Slug is the stable identity key — do not change slugs of existing exercises.
