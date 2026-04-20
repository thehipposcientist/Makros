# Thallo — Recommendations & Roadmap

Last updated: 2026-04-20

---

## Pre-Deploy / TestFlight Pilot

These came out of the pre-deploy audit. Items are ranked by severity — a small closed TestFlight pilot can likely go with BLOCKERs addressed and HIGH items tracked. Nothing in a public launch should go without HIGH items resolved.

### BLOCKER — must fix before any deploy

#### Inject secrets via env vars (not `.env` file) in prod
`backend/.env` is correctly gitignored and NOT in git history — verified. But the `.env` pattern must not ride along with the Docker image. On AWS App Runner / ECS, inject `SECRET_KEY`, `OPENAI_API_KEY`, `USDA_FDC_API_KEY`, `DATABASE_URL` via AWS Secrets Manager or environment config. Remove the `.env` copy from the Docker build context.

#### Validate `SECRET_KEY` on startup
`backend/app/auth.py:15` — `os.getenv("SECRET_KEY")` returns `None` silently if unset, then JWT fails on first request. Add a startup check that raises if missing or <32 chars.

#### Lock down CORS origins
`backend/app/main.py:12-18` — still `allow_origins=["*"]` with `allow_credentials=True`. Lock to the actual client origin(s). Read from env var so staging/prod can differ.

#### Rate-limit auth endpoints
`/auth/login`, `/auth/register`, `/auth/reset-password` have no rate limiting. Add `slowapi` middleware — 5/hr per IP on register, 10/hr per IP + 50/hr per email on login, 3/hr per email on reset.

#### Replace dev-mode `/auth/reset-password` flow
Current endpoint resets any account by email alone — dev-only. Before any outside testing, replace with a proper token-based flow: email-delivered one-time code, short TTL, single-use.

### HIGH — address before expanding beyond TestFlight

#### Structured JSON logging
Many `print()` calls; no log level / request ID / user ID in output. Configure Python `logging` with a JSON formatter so CloudWatch queries actually work.

#### Auth audit logging
No record of who logged in, from where, when password was reset, or on what device. Add `logger.info` at every auth event with IP + email + outcome.

#### Graceful shutdown hook
`backend/app/main.py` has no `@app.on_event("shutdown")`. On deploy rollovers the SQLAlchemy pool doesn't drain cleanly. Add shutdown hook that calls `engine.dispose()` and waits for any in-flight background threads.

#### Stronger password validation
Reset endpoint accepts 6-char passwords. Registration requires 8. Lift both to ≥10 with at least one digit — the bottom of modern guidance.

#### Connection pool + pre-ping
`backend/app/database.py` — confirm `pool_pre_ping=True` and set `pool_size=20, max_overflow=10, pool_recycle=3600` for RDS so idle connections get refreshed.

#### Request-ID middleware
Add an `X-Request-ID` middleware that injects a UUID per request and logs it. Makes production debugging orders of magnitude cheaper when tracing an error across OpenAI + DB + app logs.

#### Silent exceptions in startup hooks
`main.py:48-51, 144-145, 159-160, 237-238` — all wrap background init in `except Exception: print(...)`. A failed seed looks identical to a successful one. Replace with `logger.exception(...)` and let critical-path failures bubble.

#### Readiness probe
App Runner can start routing traffic before migrations / seeds finish. Add a `GET /ready` endpoint that tests DB connectivity — separate from `/health` which just returns 200.

#### Production API URL on client
`src/services/api.ts:15` — hardcoded placeholder `'https://your-production-api.com'`. Pull from `expo-constants.expoConfig.extra` so TestFlight build points at the real API.

### MEDIUM — nice before scale-up

#### Silent swallow on `/workouts/complete` structured persistence
Already raised to `WARNING` level — keep an eye on it after deploy. If it fires in prod, add the failure reason to an error-reporting sink.

#### (Shipped) Paginate all list endpoints
`GET /workouts`, `GET /meals`, `GET /meals/common`, `GET /meals/history` — all accept `skip`/`limit` + date-window params. Default 50, max 100. Progression endpoint capped to last 90 days.

#### (Shipped) `UserState` blob cap 5MB → 1MB

#### (Shipped) Security headers
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` on every response; HSTS when request came in over HTTPS.

#### (Shipped) Timezone consistency audit
Replaced deprecated `datetime.utcnow()` across `progression.py`, `plans.py`, `workout/history.py`. The naive-UTC pattern is preserved where the DB column is `TIMESTAMP WITHOUT TIME ZONE`; tz-aware everywhere else.

### LOW — notes for later

- **Error reporting** — wire up Sentry / Rollbar / CloudWatch alarms. TestFlight can survive without; launch shouldn't.
- **Migrations** — backend creates schema on startup via SQLModel. Fine for solo dev, brittle once you have real user data. Add Alembic before the first breaking schema change.
- **Backup / restore** — RDS automated backups handle this if enabled; verify retention window (7 days min for TestFlight).

---

## Storage, Retention & List-Endpoint Strategy

**Short answer:** don't prune historical data; do bound every read. Lift pagination + date filters onto the existing list endpoints now so the API contract is stable before TestFlight opens. Offset pagination is fine for launch, cursor pagination is a later upgrade. The real risk is unbounded reads, not row-count growth.

### Principles

- **Keep durable, user-owned data forever.** Workouts, sessions, sets, meals, items, check-ins, plan assignments — all valuable for trends, PRs, streaks, and coaching logic. Deletion is irreversible and users never thank you for it.
- **Bound every read.** If no screen needs 2 years of meals in one shot, the endpoint must never return that by default. Force clients to page or filter by date.
- **Separate durable product history from disposable cache.** Don't shove transient state into the same tables (or the same blob) as long-lived history.
- **Retention is a product decision, not a storage one.** Plan for account deletion and data export; don't auto-prune for space.

### What's good today (keep unchanged)

- **Client-side windows** are already right-sized:
  - `workoutHistory` keeps 100 entries
  - `mealChecks` keeps 14 days
  - `nutritionPlansByDate` keeps 14 days
  - `userState` blob has a 5MB validator cap
- **DB indexes** already exist on the core read paths (`WorkoutCompletion(user_id, workout_date, focus_label)`, `WorkoutSession(user_id, workout_date)`, `Meal(user_id, meal_date)`, `UserGoal` partial unique). Good.
- `GET /workouts/completions` already accepts `limit` with `le=500` — this is the right pattern, extend it.

### What to change now (before TestFlight)

**Bound and date-filter every list endpoint.** Pick defaults that match actual UI needs; make the cap a hard `le=` constraint:

| Endpoint | Today | Target |
|---|---|---|
| `GET /workouts/completions` | `limit` max 500 ✓ | Keep. Add optional `since`, `before` date params. |
| `GET /workouts` (sessions list) | Unbounded | `limit` default 50, max 100. Support `since` / `before`. |
| `GET /meals` | Unbounded when no date | Require a date window OR default to last 30 days. `limit` default 50, max 100. |
| `GET /meals/history` | Needs verification | `limit` default 20, max 100. Default lookback 30 days. |
| `GET /meals/common` | No date limit | `lookback_days` default 90, max 180. `limit` default 20, max 50. |
| `GET /workouts/progression/{exercise}` | Check — likely unbounded | Cap at last 90 days of sets. |

**Concrete implementation checklist** (file → function):

- `backend/app/routers/workouts.py` → `list_workouts()` at `:847`. Add `skip` + `limit` Query params + optional date range. `query.offset(skip).limit(limit)`.
- `backend/app/routers/meals.py` → `list_meals()`. If no date → default last-30-days filter. Add `limit` / `skip`.
- `backend/app/services/nutrition/meal_history.py` → `get_common_meals()` and `get_meal_history()`. Accept `lookback_days` + `limit`.
- `backend/app/routers/workouts.py` → progression endpoint. Cap to last 90 days of matching sets.

**Add missing indexes** for any query path that sorts on a non-indexed timestamp:
- `Meal(user_id, created_at DESC)` if `created_at` is used for rolling windows (or `meal_date` if that's the sort key).
- `WorkoutCompletion(user_id, completed_at DESC)` — already covered by the composite index on date; verify `completed_at` queries use it.
- `meal_items(meal_id)` — verify via `\d meal_items` that this is indexed (it's a FK so usually is).
- Run `EXPLAIN ANALYZE` on each paginated endpoint under a realistic row count (1k+ rows/user) before launch.

**Don't over-engineer.** For TestFlight:
- **Offset pagination is fine.** `LIMIT N OFFSET M` on top of a dated index performs well until you're past ~100k rows per user per table, which no pilot user will hit. Cursor pagination by `(created_at, id)` is the follow-up upgrade, not a launch blocker.
- **No auto-prune, no cold storage tier, no data archival pipeline.** All of those are premature.

### userState blob — watch this

The 5MB validator is a good safety cap but the architecture has a real risk:

- Every small update rewrites the whole blob (O(N) writes for O(1) changes).
- Cross-device merge is lossy — last-write-wins on a blob means one device can clobber another's changes.
- There's a gravitational pull to shove more things into the blob as they're needed. Once it's carrying historical records or AI-generated content it's hard to pull them back out.

**Guidance:** treat `userState` as *current state + preferences + recent cache*, not as a record store.
- ✅ OK: themeName, `recoveryExpanded`, routine toggles, last-seen notifications, small UI prefs.
- ⚠️ Borderline: 14-day `workoutHistory` skeleton (currently synced here — fine because it's bounded).
- ❌ Avoid: full meal history, long-term plan archives, generated content that has a proper table elsewhere.

**Action:** tighten the cap from 5MB → 1MB once we've confirmed no user is close to it. A client push over cap should surface a clear error, not silently truncate.

### Durable vs cache tables — conceptual split

Keep these as write-forever durable:
- `workout_sessions`, `workout_exercises`, `exercise_sets`
- `workout_completions`
- `meals`, `meal_items`
- `weekly_checkins`
- `goal_history`, `plan_change_history`
- `user_profiles`, `user_goals`, `user_preferences`

Keep these bounded / prunable / cache-like (add TTLs or LRU eviction when they show up):
- `plan_jobs` — prune on success ≥7 days old
- AI search cache (when built — see open item) — TTL-based
- Transient UI state shuttled via `userState`
- `user_recent_foods` — cap to last N per user

### Data governance (plan for launch, not today)

- **Account deletion.** User taps "delete account" → soft-mark, 30-day grace, hard-delete all user-scoped rows. No code yet but expose the intent in the privacy policy.
- **Data export.** `GET /user/export` → returns a ZIP of their JSON (workouts, meals, notes). Required for GDPR/CCPA if you ever open Europe/California. Pilot can punt.
- **Optional clear-history.** Nice-to-have. Probably a per-category toggle (clear meal history, clear workout history separately). Don't build until asked for.

### Prioritized action plan

**Do now (before TestFlight):**
- ✅ Added `limit`/`skip`/`since`/`before` to `GET /workouts` (default 50, max 100).
- ✅ `GET /meals` defaults to last 30 days; `limit` default 50, max 100.
- ✅ `GET /meals/common` accepts `lookback_days` (default 90, max 180) + `limit` (default 20, max 50).
- ✅ `GET /meals/history` accepts `limit` (default 50, max 100) on top of existing `days` (default 30).
- ✅ `GET /workouts/progression/{exercise}` capped to last 90 days of sets.
- ✅ `GET /workouts/completions` accepts `since`/`before` in addition to `limit`.
- Verify `meal_items(meal_id)` index exists; add if missing. (Open — do a `\d meal_items` against prod RDS after deploy.)
- `EXPLAIN ANALYZE` the paginated endpoints with 1k rows/user seeded. (Open — do as a sanity check after TestFlight users start logging.)

**Do soon (before launch):**
- Cursor pagination on `GET /workouts` and `GET /meals` — keyset on `(created_at, id)`. Offset works fine for pilot-scale; defer until load demands it.
- ✅ Prune `plan_jobs` rows ≥7 days old — shipped in the startup cleanup hook (`main.py:_cleanup_orphaned_plan_jobs`).
- ✅ Tighten `userState` cap to 1MB — shipped (`profile.py:UserStateBody`).
- ✅ `GET /profile/export` returning a nested JSON of every user-scoped row — shipped. Client can zip if needed.
- ✅ `DELETE /profile/account` soft-delete with email scramble + `{"confirmation":"DELETE"}` guard — shipped.

**Later (after growth signals demand it):**
- Partition `exercise_sets` by `created_at` month.
- Cold-storage archival of workout_sessions >2 years old.
- Per-category "clear history" tools.
- Real analytics pipeline — don't put product analytics queries on the same DB as transactional reads.

---

## Open Recommendations

### Engineering

#### Production API URL
`api.ts:15` — hardcoded placeholder `'https://your-production-api.com'`. Must be an env var via `expo-constants`.

#### CORS Production Origin
Backend CORS is still `*`. Lock down to production origin(s) before deploy.

#### AI Search Result Cache (New)
AI-driven food and exercise search results are thrown away per-request. Add an `ai_search_cache` table keyed by `(type, normalized_query)` storing the result blob + hit count. On subsequent searches (any user), hit cache first → skip OpenAI, shave seconds and cost. Invisible to users; no library pollution. Foundation for an eventual community-exercise tier if usage proves demand.

#### CI/CD Pipeline
No `.github/workflows/`. Tests only run when a developer runs `make test`. Add GitHub Actions for PR checks (lint + `make test`).

#### N+1 in `progression_insights`
Batch the per-exercise queries in the progression endpoint.

#### `_ai_backfill_micros` Bypasses Helpers
Direct `client.chat.completions.create()` call instead of going through `_chat_create` / `_build_chat_kwargs`. Route it through the helpers so gpt-5 param normalization applies.

#### MealEditModal Reseeds on Prop Identity Change
Unsaved edits get blown away when parent re-renders with a new `meal` prop. Stabilize the initial state so reseeds only happen on actual content change, not reference change.

#### `MIN_SAFE_CALORIES` Constant Unused / Inconsistent
Referenced in some paths but the safety floor is enforced elsewhere. Consolidate so there's one canonical constant everyone reads.

#### Reference Ranges Don't Apply Safety Floor
`/profile/calorie-ranges` returns raw TDEE math; doesn't clamp to 1200F / 1500M floor. Should apply the same floor used at plan generation.

#### List-endpoint bounds (rolled up below)
See the **Storage, Retention & List-Endpoint Strategy** section for the full table: `GET /workouts`, `GET /meals`, `GET /meals/history`, `GET /meals/common`, and the progression endpoint all need `limit` + date-window defaults before TestFlight.

### Fitness Domain

#### Deload / Periodization Mechanism
No deload weeks, no volume periodization, no block structure. At minimum: auto-deload after 4 weeks of progressive loading.

#### HYROX Tempo Running at Low Day Counts
3-day HYROX needs at least one dedicated running tempo session.

#### Cap Zone 2 Duration
Z2 can reach 70 minutes. Cap at 45–50 for recreational users.

#### Fitness Score Gender-Blind
Score formula doesn't adjust for sex. Strength pillar in particular benefits from sex-aware baselines.

#### Recovery Bonus Too Slow
Nutrition-driven recovery bonus currently sits at 1–5% effective. Consider scaling up or widening the protein-intake bands.

#### Hydration Bonus Always 0 (No Tracking)
Hydration target + utility exist on the client, but there's no intake tracking pipeline, so the score pillar always contributes 0. Add a water-logging flow or drop the pillar.

#### Apple Health Auto-Import
Code exists for reading. Missing: auto-import workouts into fatigue system so strength sessions logged on Apple Watch flow through to readiness.

#### Workout-Aware Macro Adjustment
Currently shows tips. Phase 2: adjust actual macro targets by ±10% on hard vs rest days.

### Polish / Feature

#### Meal Name Editable at Card Level (New)
Shipped 2026-04-20 — see completed list. Leaving this here for the pattern: other inline-edit opportunities (exercise name on an active workout, workout focus label) could follow the same pattern.

#### Social Sharing
`react-native-view-shot` + `expo-sharing` installed. Let users share PRs, body scans, workout summaries.

#### Exercise Image Coverage
32/201 exercises have wger images. Fill gaps by seeding custom images for the most common 50 lifts.

### Lower Priority / Future

#### Subscription Infrastructure
RevenueCat for managing subscriptions. AI features behind paywall; deterministic features stay free.

#### Android Support
`react-native-health` is iOS only. Need `react-native-health-connect` for Android.

#### Direct Garmin API
Requires Garmin Health API business application (weeks). Apple Health bridge covers most users.

#### Community Exercises (Tier 2 of AI cache)
If the AI search cache sees consistent re-hit traffic on user-added exercises, layer a `community_exercises` table with a save-count threshold. When N distinct users have saved an exercise, surface it in the default library under a "Community" section. Start with cache-only; graduate to this only if demand is real.

---

## Completed

### Critical
- Calorie safety floor restored (1200F / 1500M per day)
- ExerciseSet cascade delete fixed (workout_exercise_id)
- Silent exception swallowing → rollback + targeted re-raise (now WARNING-level logging too)
- Smoke-test endpoint gated behind auth
- Production SECRET_KEY generated (64-char hex)
- USDA API key set

### Engineering
- Error boundaries wrapping all tab content
- N+1 queries fixed (batch MealItem loads in meals.py + meal_history.py)
- Database indexes added (WorkoutCompletion, WorkoutSession, Meal, UserGoal)
- UserState blob size validation (5MB limit)
- Response models on fatigue, workout status, nutrition score endpoints
- Password validation (min 8 chars)
- Print → logger in workouts.py, planner.py, weekly_recipe.py
- All 10 test modules (183 tests) registered in `run_all.py`
- `aiWorkoutPlan` + `workoutHistory` added to SYNCED_STATE_KEYS (sign-out → backend, sign-in restores)
- `GET /workouts/completions` endpoint for skeleton hydration on fresh installs
- Cold-start hydration: pulls user state blob + workout completions when local is empty
- `POST /workouts/sync` — per-set backend persistence during active workouts (debounced 1.5s)
- Equipment enum coercion in `/workouts/complete` + `/workouts/sync` (unblocks the previous silent-persistence failures)
- Atomic signup: auth token only persisted after onboarding completes; quit mid-onboarding wipes in-memory state
- Exit signup → back to auth (confirm modal + local-state reset)
- Forgot password flow (dev-mode: email + new password, no token)
- OpenAI SDK 2.31 compat: `reasoning_effort="minimal"` (string, chat.completions) replaces legacy `reasoning={"effort": "minimal"}` dict
- Splash logo pulsing replaced with teal shimmer sweep
- Splash emails typo in stacyhannel21 corrected in DB; email trim/lowercase still pending as a hardening step

### Fitness Domain
- Systemic fatigue decay extended to 5 days (0.05/0.02 for days 4–5)
- Strength prescription: "3–5" reps for pure strength
- Endurance maintenance: "15–20" reps at 45s rest
- Short interval rest: 120s (1:3 ratio)
- Muscle gain at 3 days: full body preferred over PPL
- Recovery/mobility days: negative fatigue (active recovery)
- Two-pass fatigue: positive accumulation then recovery (max 1/day, 15% proportional, capped 0.15)
- Recovery stacking prevention (5 saunas = same as 1)
- Fatigue floor clamped at 0.0
- Recovery day allocation separate from conditioning in weekly recipe
- Recovery/mobility day scaling to session_minutes
- Injury system: 3-layer (block, recover, fatigue) with expanded body parts
- Focus auto-correction via `_infer_focus_from_muscles()` on workout completion
- Exercise dislike (thumbs down, excluded from plans)
- Multiple completions per day: upsert key changed to (user, date, focus)
- Compound Strength recipe: 5 sets primary, 4 min rest, UL only
- Marathon goal enabled
- Glute isolation added to all standard lower/legs day templates
- Vertical pull added to upper heavy slots
- Injury approval via buttons (not auto-apply) + chat clears after
- Injury auto-save to AsyncStorage on every change
- Injury boost: no longer accumulates — caps at injury level
- Focus_override passed to fresh-day generation so the split can't get swapped

### Nutrition Domain
- Micronutrient backfill: no 20-item cap, batches all items
- Iron RDA sex-aware: male=8mg, female=18mg (backend + client)
- Endurance protein comment fixed (1.76 g/kg)
- USDA serving size: household text parser (tbsp→15g, cup→240g, etc.)
- Allergen filter: 8 categories, word-boundary regex, runs post-AI generation
- Meal history system: 6 functions, 5 endpoints, auto-log on check-off
- Nutrition recovery integration: `nutrition_context` on fatigue endpoint (4 protein tiers)
- Low protein penalty (+3% fatigue) + insight message on recovery card
- Nutrition score tags: actual ratio + directional messaging + actionable gap
- Score detail view: tappable card with adherence/quality/micro bars
- Health Score on Progress: real meal data via `getMealAverages`
- Common meals "YOUR FAVORITES" horizontal scroll on Foods sub-tab
- Food search source badges (USDA green / AI purple) + force-AI button
- Food conversion fix: ratio now 1 across weight↔volume (preserves physical amount, no more 0-cal on unit switch)
- Shrimp / prawn / salmon / tuna / tilapia added to density lookup
- Rolling nutrition averages: denominator changed to window days (not logged days)
- Hydration: client score infrastructure + `hydration.ts` utility + water target on meals tab

### AI / Coach
- Unified single coach chat (topic picker removed)
- gpt-5-mini migration: scanning endpoints with reasoning params
- `_build_chat_kwargs`: `max_completion_tokens` + `reasoning_effort=minimal` for gpt-5
- Direct OpenAI calls in scanning.py routed through helpers
- Plan update approval: chat auto-closes 1.5s after applying
- Backend auto-detects topic from keywords for context trimming
- Coach timeout: `askWorkoutQuestion` increased to 60s
- Coach capabilities hint in empty chat (6 categories + description)
- Short replies ("Yes" / "No" / "Sure") allowed mid-conversation in trainer chat
- Injury proposal: AI now returns structured `updated_injuries` on first mention instead of asking for text "yes" — existing Add & Update Plan button renders
- Image MIME fix (`_fix_image_mime` for HEIC via Pillow)

### Polish / UX
- Meal name inline-editable at card level (long-press to rename)
- Theme classifications fixed: Blossom / Slate now Dark; Sunrise / Arctic now Light
- Two new light themes: Linen & Olive, Mint Fresh (29 themes total)
- PDF export via expo-print (themed HTML, two-column, Thallo logo, username+date filename)
- Export moved from Profile tab to Progress > History tab
- Workout sub-tabs: Plan / Library / Settings
- Meals sub-tabs: Plan / Foods / Supps
- Library tab has exercises/muscles toggle inside
- Injuries moved from Goal tab to Workout Settings tab
- Injury body part picker (not free text) with muscle group mapping
- Per-day nutrition scores on NutritionCard headers
- Food quality dots on meal items (green/red/gray)
- Resume workout: themed modal, only shows if sets logged
- Rest timer AI badge prominent (16px bold on accent bg)
- Stretches/bodyweight exercises hide weight column
- AppState listener for timer catch-up on foreground return
- Workout start time persists to AsyncStorage
- Barcode scanner ref-based lock prevents multiple scans
- Meal edits auto-persist to AsyncStorage
- Saved meals no longer rejected by micros check on reload
- Routine overlay skipped for saved/remote plans
- Spin Class + Pilates activity subtypes
- AI coach button toned down (surface bg, outline icon)
- Manual activity history shows full detail ("Recovery · Sauna (easy)")
- Serving display: "1 serving (~200g)" for vague units
- Dark theme fixes: MealEditModal text, image placeholders, skeleton loader
- Accessibility labels on ~15 key interactive elements
- "Overall Load" label replaces "CNS / Systemic" in recovery card
- Coach memory: SQL LIMIT (default 10, max 50)
- Coach check-in button removed from AI chat
- "General Questions" renamed, informational only note
- Weekly check-in restored (auto-popup only, countdown banner)
- Active activities category: Yard Work, Chopping Wood, Moving, Gardening, House Cleaning, Construction, Shoveling, Playing w/ Kids, Dancing
- Sport expanded: Pickleball, Surfing, Skiing
- Plan generation loop fix: staleness check, AsyncStorage persistence, race condition prevention
- Fresh day flag no longer cleared on initial mount (tracks previous values)

---

## Feature Completeness

| Feature | Status |
|---------|--------|
| Auth (login/signup, min 8 char password, forgot password) | Done |
| Onboarding (5 steps, atomic — exit cleans up) | Done |
| Training day selector | Done |
| Goal selection (11 goals + HYROX + Marathon) | Done |
| Deterministic workout planner | Done |
| Per-day generation with history | Done |
| Day swap (deterministic UI + generated recovery/mobility/cardio) | Done |
| Active workout tracking + per-set backend sync | Done |
| Timed exercise support | Done |
| Exercise images from wger.de | Done (32/201) |
| Exercise search (wger + AI) | Done |
| Exercise dislike (thumbs down) | Done |
| 12-muscle-group fatigue system + extended CNS decay | Done |
| Two-pass recovery (proportional, capped, no stacking) | Done |
| Negative fatigue for recovery/mobility | Done |
| Nutrition recovery integration (4 protein tiers + penalty) | Done |
| Recovery readiness + muscle bars + nutrition insight | Done (expandable) |
| Progressive overload display | Done (needs deload) |
| Set programming (warmup/heavy/backoff) | Done |
| In-workout AI set review | Done |
| Manual activity logging (strength/cardio/mobility/sport/active/recovery) | Done |
| Multiple completions per day | Done |
| Recovery/mobility day scaling (time-budget, bypass slot system) | Done |
| Weight tracking (unified) | Done |
| Food search (USDA + AI with force toggle) | Done |
| Barcode scanning | Done |
| Meal planning (AI) | Done |
| Meal name inline rename (long-press) | Done |
| Food photo scanning | Done |
| Meal history system (auto-log, averages, common, insights) | Done |
| Common meals "YOUR FAVORITES" UI | Done |
| Nutrition scoring (client-side + real meal data + detail view) | Done |
| Combined health score (14-day backward-looking, activity + nutrition) | Done |
| Food quality classification | Done |
| AI coach (unified, button-confirmed plan changes) | Done |
| Body scan (AI) | Done |
| Injury tracking (3-layer, body part picker, AI recovery estimation) | Done |
| Progress history + PRs | Done |
| Data export (PDF via expo-print, themed) | Done |
| 29 themes (Dark + Light groups classified correctly) | Done |
| Weekly check-in | Done |
| Push notifications | Done |
| Splash screen (shimmer sweep) | Done |
| Error boundaries | Done |
| Calorie safety floor (1200F/1500M) | Done |
| Database indexes | Done |
| Response models | Done |
| Automated test suite | 10 modules, 183 tests |
| CI/CD | Not configured |
| Apple Health write | Not wired |
| Subscription/paywall | Not built |
| AI search result cache | Open — recommended |
