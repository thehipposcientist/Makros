# Thallo — AGENTS.md

## Project Overview
Thallo is a premium fitness + nutrition app. React Native (Expo) frontend, FastAPI backend. Users complete onboarding (goal, schedule, equipment, foods), receive a **deterministic** workout plan and an AI-enriched nutrition plan, then track workouts, meals, weight, and recovery.

## Tech Stack
- **Frontend**: React Native 0.81.5 / Expo SDK ~54 / expo-router v6 / TypeScript
- **Backend**: FastAPI + SQLModel + PostgreSQL 16 (Docker)
- **AI**: OpenAI `gpt-4o-mini` — meal skeletons, coach chat, food scanning, in-workout set review, food classification fallback, first-time weight rec. **Workout planner is fully deterministic.**
- **External data**: USDA FoodData Central (nutrition, incl. added sugars #1235), wger.de (exercise images/search)

## Core Invariants
These rules apply to every change:

1. **Workout planner is deterministic.** No AI in exercise selection, split logic, or weekly recipe. AI plan review is PERMANENTLY DISABLED (`PLAN_REVIEW_ENABLED=0` is a no-op).
2. **DB is source of truth.** Front-page schedule = active `PlanWeek` + 7 `PlanDay` rows. Legacy `WorkoutPlan` / `NutritionPlan` tables remain for the AI artifact + nutrition templates. AsyncStorage is a hot cache only used when backend is unreachable; on conflict, DB wins.
3. **PlanWeek is fixed for 7 days.** No mid-week regeneration. Past days accumulate as done / skipped, today is highlighted, forward days remain queued. New PlanWeek auto-generates only when `end_date < today` (auto-renew). The legacy daily fresh-day regen on app open is **removed**.
4. **AI can only do what the user can do.** Recommendations mutate `UserPreferences` / `UserCoachingState` / `UserDayState` — never the active `PlanWeek` directly. All AI actions route through `POST /coach/apply-action`.
5. **Nutrition scoring is server-authoritative.** `/meals/score` is the source of truth for logged meals. Client `nutritionScore.ts` is plan-preview only.
6. **Plan cache clear is scoped.** Use `clearWorkoutCache()` / `clearMealCache()` / `clearAllPlanCache()`. Never wipe unrelated domains.
7. **Preserve API contracts or update all callers.** Backend + frontend + watch changes must stay in sync.
8. **Social data boundary.** Calorie/macro/weight data NEVER crosses the social boundary — digest reads `WorkoutCompletion` only.
9. **Fatigue system**: 12 muscle groups, decay-based, recovery/mobility days have NEGATIVE fatigue.
10. **Warmup prescription is always short + dynamic.** Never long yoga/stretch blocks before heavy lifts.
11. **PLUS_CARDIO archetypes are injected AFTER adjacency repair** — they share `focus_family` with base lift so adjacency is always preserved.

## Dev Commands
```bash
docker compose up -d                                                           # Start backend + DB
docker compose build backend && docker compose up -d backend                  # Rebuild backend image
npx expo start --clear                                                         # Frontend dev server
docker compose logs -f backend                                                 # Backend logs
docker exec thallo-pg psql -U thallo -d thallo                                # DB shell
docker exec thallo-backend python -m tests.run_all                            # All backend tests
docker cp backend/app thallo-backend:/app/ && docker compose restart backend  # Hot-swap (dev only)
make test                                                                      # Alias for run_all
```

## Environment Variables (`backend/.env`)
```
SECRET_KEY=...
OPENAI_API_KEY=...
USDA_FDC_API_KEY=...
MODEL_CHAT=gpt-4o-mini
MODEL_PLAN_GENERATION=gpt-4o-mini
MODEL_MEAL_PARSING=gpt-4o-mini
PLAN_REVIEW_ENABLED=0       # no-op — AI plan review permanently disabled
NUTRITION_REVIEW_ENABLED=0  # no-op
```

## Key Folders
```
app/                          # Expo router root (_layout.tsx, index.tsx)
src/
  screens/                    # Auth, Onboarding, Home, ActiveWorkout, Progress, Supplements
  components/                 # NutritionCard, WorkoutCard, FuelingRecoveryCard, FriendsModal, ...
  utils/                      # swapScoring.ts, nutritionScore.ts, planCacheReset.ts, ...
  services/api.ts             # All backend API calls
backend/
  app/
    main.py                   # FastAPI + startup migrations
    database.py               # Engine + idempotent ADD COLUMN IF NOT EXISTS migrations
    models.py                 # SQLModel tables
    routers/                  # auth, meals, meta, profile, workouts, coach, social, ai/
    services/
      workout/                # planner, fatigue, recipes, prescriptions, archetypes, slots, ...
      nutrition/              # nutrition_score, gut_health, food_classifier, recovery_flags, ...
      coach/                  # checkin_ai, decision_rules, apply_action
      social/                 # digest (pure-function, no DB writes)
  tests/                      # run_all.py — 21 known pre-existing failures are acceptable baseline
targets/thallo-watch/         # Apple Watch SwiftUI app
modules/thallo-watch-bridge/  # WCSession phone bridge
modules/thallo-healthkit/     # Apple Health read/write
```

## Working Rules
- Make minimal, targeted diffs. Do not refactor unrelated files.
- Do not add error handling for scenarios that can't happen inside the system.
- Do not add comments that explain what well-named code already says.
- Run `make test` after backend changes. Fix new failures before marking done.
- DB migrations: add idempotent `ADD COLUMN IF NOT EXISTS` helpers to `database.py`; they run on startup.
- When changing an API response shape, update `src/services/api.ts` and all screen consumers.
- When changing watch payloads, update both `modules/thallo-watch-bridge/` and `targets/thallo-watch/`.

## Architecture Docs
Read before editing these areas — do not auto-import, consult manually:

| Area | Doc |
|---|---|
| Workout planner, fatigue, cardio, splits | `docs/architecture/workout-system.md` |
| Nutrition scoring, food classifier, flags | `docs/architecture/nutrition-system.md` |
| AI coaches, apply-action, intent router | `docs/architecture/ai-coach-system.md` |
| Apple Watch sync, complications, Siri | `docs/architecture/apple-watch.md` |
| Social / friends / digest | `docs/architecture/social-system.md` |
| Apple Health / HealthKit / HKDataSummary | `docs/architecture/healthkit.md` |
| Plan persistence, AsyncStorage, cache | `docs/architecture/plan-persistence.md` |
| DB migrations list | `docs/engineering/database-migrations.md` |
| Test suite coverage + gaps | `docs/engineering/test-suite.md` |
| UI layout, tab structure, onboarding | `docs/product/ui-layout.md` |
| Supported goals + splits | `docs/product/supported-goals-and-splits.md` |
| Roadmap + next improvements | `docs/product/roadmap.md` |
| Known contradictions / stale notes | `docs/product/backlog-review.md` |
