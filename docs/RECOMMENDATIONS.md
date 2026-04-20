# Thallo — Recommendations & Roadmap

Last updated: 2026-04-20 (post-first-pilot session)

---

## In Flight / Unstable (as of 2026-04-20 EOD)

Tracking the half-built things so the next session doesn't forget them.

### HealthKit on TestFlight — still broken
iOS rejects the HealthKit entitlement at runtime despite:
- App ID has HealthKit capability (verified in Developer Portal)
- Provisioning profile regenerated fresh (`5SBAWC7KFJ`, synced with no capability drift)
- Local `npx expo prebuild` produces a clean `.entitlements` with `com.apple.developer.healthkit: true`
- EAS build log shows `RCTAppleHealthKit` compiling into the IPA
- iPhone Settings → Thallo shows no Health row (diagnostic: `initHealthKit` has never run successfully)

**Next diagnostic step**: build 11 surfaces the raw iOS error via `Alert` (added `getLastHealthKitError()` in `src/services/appleHealth.ts`). That text is the missing puzzle piece. If still opaque, download the signed IPA from EAS and inspect with `codesign -d --entitlements :- Payload/*.app`.

### Live Activities — scaffolded, not yet built
All code in place: widget extension target (`targets/resttimer-widget/`), local Expo module (`modules/thallo-live-activity/`), JS service (`src/services/liveActivity.ts`), wiring in `ActiveWorkoutScreen`. Expected 2–4 EAS build iterations before Apple/Xcode accept the widget signing. First build blocked on needing an interactive `eas build` run to register the widget's bundle ID (`com.thallo.app.widget`).

### Recovery Question flow — backend done, client half-wired
- Backend: `User.recovery_question` + `recovery_answer_hash` columns + `/auth/recovery-question`, `/auth/set-recovery-question`, rewritten `/auth/reset-password` — shipped.
- Frontend: API client methods + new two-step reset UI in `AuthScreen` — shipped.
- Frontend: `RecoveryQuestionModal` component exists but **not yet rendered** from `app/index.tsx`. Post-login check for `has_recovery_question` needs to render the modal over the Home screen as a blocking prompt for pre-existing users.

### Notifications v1 — not started
`expo-notifications` plugin ships and auto-requests permission. No scheduling code yet. V1 scope: workout reminder (daily, training days only) + meal-log nudge (8pm if nothing checked). ~45 min of work.

---

## Performance & Scalability

Ordered roughly by cost-to-fix × impact. Items here are *not blockers* — the app works today — but each pays dividends as users grow past pilot.

### Client

#### Debounced `userState` pushes (HIGH impact, LOW effort)
Every small change triggers a full `putUserState` call. On a workout with 20 set logs, that's 20 full-blob writes to the backend. Batch via a 2–3s debounce in `pushUserStateToBackend` and the AppState background hook. One write per meaningful pause instead of per-keystroke.

#### Image lazy-loading on exercise library (MEDIUM)
`Library` tab renders all 201 exercise images up-front. Most users scroll ~20 before bouncing. Use `react-native-reanimated` + an `IntersectionObserver`-like hook (or just `initialNumToRender={15}` on `FlatList` if it's a list) so only visible images load.

#### AsyncStorage write coalescing (MEDIUM)
Multiple paths write to the same AsyncStorage key within a single render pass (e.g., meal edits → `nutritionPlansByDate` → `mealChecks` → `mealEdits`). Each `setItem` is a disk write. Batch via `multiSet` when more than one key changes in the same tick.

#### JS bundle size audit (LOW, but worth measuring)
Haven't profiled `npx expo export --platform ios`. Likely candidates for bloat: `react-native-svg` usage for simple shapes, duplicated theme color definitions, dead code from removed features (workout regeneration fallback, legacy topic-picker chat). Run a tree-map analysis (Metro bundle visualizer) and see what's actually loading.

#### Metro-Ready timings
Cold start time on a fresh install is dominated by:
1. Metro bundle download (dev) / IPA launch (prod)
2. Initial `getMe` + `loadProfile` + `pullUserStateFromBackend` all blocking the auth-to-home transition.
Consider parallelizing item 2 more aggressively — only `getMe` needs to succeed before we render; the profile + state can stream in after.

### Backend

#### App Runner cold start penalty (HIGH impact, MEDIUM effort)
App Runner scales to 0 during idle. First request after idle takes 5–15s to warm the container. For a pilot where users might open the app hourly at most, every open is a cold start. Two options:
- **Min instances = 1** (AWS Console → App Runner → Configuration → Instance → Minimum size). ~$15–25/month addition. Eliminates cold starts.
- **Warm pinger**: CloudWatch Events rule hitting `/health` every 5 min. Free, but slightly hacky. Makes the bill grow via App Runner concurrency if sustained.

#### `progression_insights` N+1 (MEDIUM)
Noted in existing recs. Batch the per-exercise queries into a single `IN (...)` SQL or eager-load via `selectinload()`.

#### AI response caching (HIGH impact, MEDIUM effort)
Already noted: `ai_search_cache` table keyed by `(type, normalized_query)`. Expand scope:
- Cache exercise searches (wger + AI): reuse across ALL users
- Cache food searches: reuse across ALL users
- Cache recipe generation: per-user only (ingredients vary)
Target ~60% cache hit rate after pilot ramp-up. Each hit saves ~2s + ~$0.0002 of OpenAI.

#### `plan_jobs` table unbounded growth (LOW — already pruned)
Existing 7-day prune runs on startup. If App Runner rarely restarts, prune could lag. Consider a daily-scheduled worker hook (`apscheduler` in-process or an external cron).

#### Query cache for exercise library (LOW)
The `/exercises` endpoint returns ~200 rows unchanged per user per day. Client caches for an hour via `useMetaData`. Backend could return an `ETag` so subsequent fetches are `304 Not Modified` and skip serialization entirely.

#### RDS pgbouncer / RDS Proxy (LATER)
Pool_size=20 works now. Past ~50 concurrent users, consider RDS Proxy in front so connection-heavy retries don't DOS the DB.

#### Deferred heavy computations to background tasks (LATER)
`progression_insights`, `fitness_score`, `health_score` are all computed on-demand synchronously. Under load, move to a nightly worker that materializes per-user rollups, served from a `user_rollups` cache table.

### Network / Infra

#### NAT Gateway reconsideration (architectural)
Currently App Runner outbound is Public → RDS also Public with `0.0.0.0/0:5432` SG. Fine for pilot. Before opening external testing, switch to Custom VPC + NAT gateway (~$32/mo) so RDS goes private again. Treat as pre-launch hardening.

#### CloudFront in front of `/exercises/image/*` if we ever self-host images
Today exercise images come from wger.de. If we move to self-hosted (seeded custom images covering the 50 most common lifts), CDN them. Not worth doing until self-hosting happens.

#### App Runner concurrency tuning (LOW)
Default concurrency per instance is 100. Fine at pilot scale. Revisit when signups pass ~50 users.

### Database

#### EXPLAIN ANALYZE audit post-pilot (HIGH after 1 week of real data)
Seed 1k rows/user, run each paginated endpoint, confirm index use. Already in the Storage doc; bumping priority.

#### Partial indexes for active entities (MEDIUM)
`UserGoal(user_id) WHERE is_active=true` exists. Likely other paths benefit: `WorkoutCompletion(user_id) WHERE workout_date >= CURRENT_DATE - 30` for "recent" queries. Measure first.

#### Auto-VACUUM tuning (LATER)
RDS defaults are fine for <1M rows. Revisit before crossing 10M.

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

### Features — New (2026-04-20 review)

#### Allergens (profile field + AI plan hardening)
Structured list + freeform "other". Top 8 categories (peanuts, tree nuts, milk, eggs, shellfish, fish, wheat, soy). Plan-gen prompt hardens to avoid the list; UI warns on meal items that contain flagged ingredients. **Defer until any pilot user surfaces an allergy** — premature otherwise, and the liability tradeoff is real.

#### Own Sleep Score (0–100)
Derive from HealthKit `SleepAnalysis` samples:
- Duration (7–9h = full) → 50% weight
- Consistency (7d std-dev of nightly hours, lower = better) → 25% weight
- Stage quality (% Deep+REM vs total) → 25% weight
Gated behind ≥4 of last 7 nights having samples so the score doesn't whipsaw. Surface as its own card on Progress > Body Check above fitness score. Pre-req: HealthKit working.

#### Sleep-driven engagement nudge
One-line tag on Home when sleep is meaningfully off 7d avg:
- `<6h last night` → "Light day? Deload the top sets."
- `>8h + low RHR` → "Primed. Go heavy."
Only fires when delta is ≥1h or recovery marker flips. Requires HealthKit working + sleep score built.

#### Apple Watch workout auto-detect (v1, foreground)
On app foreground, fetch `workouts7d` from HealthKit, diff against in-app completions; if Apple has one we don't, prompt *"Log this Apple Watch workout? 34 min Strength, 287 cal"* with one-tap confirm. No background delivery entitlement needed. Type-matching is lossy (HK "Traditional Strength Training" is vague about muscle groups) — fallback is to ask the user for focus.

#### Live Activities — rest timer on lock screen
Already scaffolded (see In Flight section). Ships the rest timer + next-set rec on the iOS lock screen & Dynamic Island, matching the user's theme color. Iteration risk: widget extension signing + provisioning regens. Once stable, foundation for other Live Activities (workout-in-progress view, meal-log nudge card).

#### Notifications v1 (local, no push infra)
Two notification types:
- **Workout reminder** — daily at user-picked time, only on training days.
- **Meal log nudge** — at 8pm, if <50% of today's meals are checked.
Both togglable in Edit Profile. Local only (no APNs / server-driven pushes). Foundation for more ambitious coaching nudges later.

#### Draft meal persistence (defer)
After the dedupe fix (2026-04-20), new-meal drafts are lost on app kill before the Save tap. Acceptable default. If users report losing in-progress meals, add a separate `mealDraft` AsyncStorage key decoupled from the plan itself — hydrate on modal open, clear on Save/Cancel.

#### Recovery question blocking modal (finish the half-wired feature)
Backend + AuthScreen reset flow ship. Missing: render `RecoveryQuestionModal` over Home when `has_recovery_question === false` after login. ~20 min to wire.

#### Social / accountability (future)
Pair-mode: two users' progress visible to each other. "Your wife just beat her deadlift PR." Requires: backend opt-in social graph, notification infra, privacy UI. Weeks of work. Post-pilot consideration.

### Polish / Feature

#### Meal Name Editable at Card Level
Shipped 2026-04-20. Leaving here for the pattern: other inline-edit opportunities (exercise name on an active workout, workout focus label) could follow the same pattern.

#### Today's Vitals row on Progress (shipped)
Live RHR + sleep + steps + workouts + active cal from HealthKit, rendered on Body Check sub-tab. **Blocked on HealthKit entitlement working.**

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

### 2026-04-20 session (post-TestFlight-1 triage)
- Password rule: 10 → 8 chars (+ digit) — pilot-friendly, still meets modern floor
- `getBaseUrl` in `api.ts` ignores `app.json`'s `apiBaseUrl` in dev so local dev client hits `localhost:8000`, not prod (root cause of "my local login is broken")
- Food-search client timeout 15s → 45s (App Runner cold start + OpenAI can eat 20–30s)
- Clear button in `SearchInput` swapped from "CLEAR" pill → `close-circle` icon (matches MealEditModal)
- Apple Health vitals card on Progress > Body Check — RHR, last night sleep, 7d steps / workouts / active cal / avg sleep. Reads fresh `HealthSummary` on mount.
- Apple Health "Connect" button flow on Progress — 3 states (not connected → Connect button, connected+empty → "Open iOS Settings" deep link, has-data → grid)
- Raw iOS error surfacing via `getLastHealthKitError()` so TestFlight users can see the actual entitlement rejection text
- Recovery-question auth flow — backend: schema, `/auth/recovery-question`, `/auth/set-recovery-question`, rewritten `/auth/reset-password` (no more DEV gate, answer is the auth factor). Frontend: API client methods, two-step reset UI in AuthScreen. Modal component built, not yet rendered.
- `UserRead` response includes `has_recovery_question` flag
- `ensureFreshInstall()` on app boot clears SecureStore JWT if AsyncStorage is empty — fixes "auto-login into ghost profile after reinstall" (iOS Keychain persists across app delete)
- Live Activities scaffolding: widget extension target (`targets/resttimer-widget/`), SwiftUI UI with theme-colored progress ring + Dynamic Island layouts, local Expo module with ActivityKit bridge, JS service, ActiveWorkoutScreen integration (start/update/end tied to rest timer lifecycle)
- `NSSupportsLiveActivities` + frequent-updates flag in app.json
- `@bacons/apple-targets` plugin added
- MealEditModal duplicate-meal bug fix: `persistNow` no longer auto-pushes for new meals; Save is single source of truth
- `api.ts` `resetPassword` signature updated to accept answer param

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
