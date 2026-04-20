# Thallo — Recommendations & Roadmap

Last updated: 2026-04-20

---

## TL;DR — Where we are

Thallo is deployed to AWS App Runner + RDS Postgres, distributed via TestFlight, in closed pilot with you + Stacy. Backend and core app are stable; **three things are half-built or blocked** that matter most:

1. **HealthKit rejected on TestFlight** — entitlement signed but iOS won't honor it. Diagnostic alert added for build 11+.
2. **Live Activities** — widget target and native module scaffolded; EAS build iteration in progress.
3. **Recovery-question password reset** — backend + AuthScreen shipped, post-login modal not yet rendered in `app/index.tsx`.

Beyond those, the app is feature-complete for a pilot. This doc is the priority map for what comes next.

---

## Table of Contents

1. [Priority Queue (P0 → P3)](#priority-queue)
2. [In Flight](#in-flight)
3. [Open Features](#open-features)
4. [Performance & Scalability](#performance--scalability)
5. [Engineering Backlog](#engineering-backlog)
6. [Storage & Retention Strategy](#storage--retention-strategy)
7. [Pre-Deploy Hardening (historical)](#pre-deploy-hardening-historical)
8. [Completed — shipped work](#completed)
9. [Feature Matrix](#feature-matrix)

---

## Priority Queue

Triaged by blast radius × effort. Tackle top-down.

### P0 — finish what's mid-build (this week)
1. **Get HealthKit working on TestFlight.** Capture the alert text from build 11+, decode the specific iOS error, fix the entitlement path. Without this, vitals/fitness-score/sleep-score features are all blocked.
2. **Render `RecoveryQuestionModal` after login** in `app/index.tsx`. Check `me.has_recovery_question` — if false, show modal over Home until set. ~20 min.
3. **Ship Live Activities.** Iterate EAS builds until the widget target signs clean. Once stable, this unlocks "rest timer visible on lock screen" as a shippable pilot feature.

### P1 — high-impact shippable wins (next 2 weeks)
4. **Notifications v1** — workout reminders + meal-log nudges. ~45 min.
5. **Apple Watch workout auto-detect** (v1 foreground) — blocks on HealthKit P0.
6. **Own sleep score** — blocks on HealthKit P0.
7. **Warm-pinger or min-instances=1 on App Runner** — eliminate cold-start latency, the worst pilot UX.

### P2 — quality of life (next month)
8. **PR celebration + shareable cards** — free UX delight from existing `react-native-view-shot`.
9. **Weekly AI report card** — push notification/email summarizing the week's adherence, fatigue trend, PRs.
10. **Sleep-driven engagement nudge** — "light day?" or "go heavy" on Home based on sleep delta.
11. **AI search result cache** — backend `ai_search_cache` table; 60%+ hit rate cuts OpenAI cost.
12. **Body measurements beyond weight** — waist, hips, biceps, thighs as trackable fields.
13. **Meal-prep / grocery list generator** — top ask for nutrition apps, zero new backend infra.

### P3 — longer plays (quarter+)
14. **Couple/pair mode** — shared PR/streak view, opt-in.
15. **Home-screen widgets** — lightweight static daily summary card.
16. **Voice logging via Siri shortcuts.**
17. **Body photo progression** — weekly mirror selfies with timeline.
18. **Diet phase automation** — cut → maintain → bulk transitions driven by weight trend.
19. **Allergens (structured profile field).**
20. **Android support** — `react-native-health-connect` equivalent.

---

## In Flight

### HealthKit on TestFlight — rejected
iOS rejects the HealthKit entitlement at runtime despite:
- App ID has HealthKit capability (verified in Developer Portal)
- Provisioning profile regenerated fresh (`5SBAWC7KFJ`, synced with no capability drift)
- Local `npx expo prebuild` produces a clean `.entitlements` with `com.apple.developer.healthkit: true`
- EAS build log shows `RCTAppleHealthKit` compiling into the IPA
- iPhone Settings → Thallo shows no Health row (diagnostic: `initHealthKit` has never run successfully)

**Next step:** build 11 surfaces the raw iOS error via `Alert` (added `getLastHealthKitError()` in `src/services/appleHealth.ts`). Decode that error text to pinpoint the issue. If still opaque, download the signed IPA from EAS and inspect with `codesign -d --entitlements :- Payload/*.app`.

### Live Activities — scaffolded, signing iteration
All code in place:
- Widget extension target (`targets/resttimer-widget/`) with Swift widget + Dynamic Island layouts
- Local Expo module (`modules/thallo-live-activity/`) wrapping ActivityKit
- JS service (`src/services/liveActivity.ts`) with graceful fallbacks
- Wiring in `ActiveWorkoutScreen` (start on rest kick-off, update on AI rec, end on rest-end)
- Defensive try/catches at every bridge point so failure is silent, not a crash

First EAS build needs an interactive `eas build` run to register the widget's new bundle ID (`com.thallo.app.widget`). Expect 2–4 build cycles before Apple/Xcode accept the widget signing cleanly.

### Recovery-question flow — backend done, modal not rendered
- Backend: schema, `/auth/recovery-question`, `/auth/set-recovery-question`, rewritten `/auth/reset-password` (answer-driven, no DEV gate) — shipped.
- Frontend: API client methods, two-step reset UI in AuthScreen — shipped.
- `RecoveryQuestionModal` component built, not yet rendered from `app/index.tsx`. Post-login check for `has_recovery_question` needs to render the modal over Home as a blocking prompt for pre-existing users.

### Notifications v1 — not started
`expo-notifications` plugin ships and auto-requests permission. No scheduling code yet. Two notification types planned:
- Workout reminder — daily at user-picked time, only on training days.
- Meal-log nudge — at 8pm, if <50% of today's meals are checked.
Both toggled in Edit Profile. Local only — no APNs infra.

---

## Open Features

Organized by product surface. `[P?]` tag ties each to the priority queue above when applicable.

### Fitness & Training
- **Apple Watch workout auto-detect (v1 foreground)** `[P1]` — on app foreground, diff `workouts7d` from HealthKit against in-app completions; prompt *"Log this Apple Watch workout?"* with one-tap confirm. Type-matching is lossy (HK "Strength Training" doesn't say push vs pull) — fall back to user selection.
- **Deload / periodization mechanism** — no deload weeks, no volume periodization, no block structure. Auto-deload after 4 weeks of progressive loading.
- **Body measurements beyond weight** `[P2]` — waist, hips, neck, biceps, thighs. Track trendlines alongside body scans.
- **Progressive injury recovery protocols** — beyond "block movement pattern": phased re-intro with volume ramp (30% → 60% → 100% over 2-4 weeks post-injury).
- **HYROX tempo running at low day counts** — 3-day HYROX needs at least one dedicated running tempo session.
- **Cap Zone 2 duration** — Z2 can reach 70 min. Cap at 45–50 for recreational users.
- **Fitness score gender-adjusted** — strength pillar baselines don't account for sex.

### Nutrition
- **Meal-prep / grocery list generator** `[P2]` — take the week's plan, aggregate ingredients + quantities, export as a grocery list. Popular request across nutrition apps.
- **Diet phase automation** `[P3]` — user declares cut/maintain/bulk; app monitors weight trend and flags when to transition (e.g., "you've lost 8% BW in 10 weeks — time to diet-break?").
- **Carb/macro cycling** — high-carb/rest-day templates on training vs rest days.
- **Fasting / IF support** — eating window as a config; meal suggestions shift inside that window.
- **Smart meal-timing reminders** — learned from user's check-off times ("you usually eat lunch around 12:30"). Cascade notification 15 min before.
- **Allergens (structured field)** `[P3]` — top 8 + freeform. Plan-gen prompt avoids them; meal-item UI flags. Defer until a user surfaces an allergy.
- **Workout-aware macro adjustment** — phase 2 of the existing protein tip: actually adjust targets ±10% on hard vs rest days.
- **Hydration logging** — UI + score pillar exists but there's no intake flow. Add water-log buttons (quick +8oz taps) or drop the pillar.
- **Recipe builder** — saved recipes reusable across meals. Today recipes live on individual meals only.

### Coaching & Engagement
- **Own sleep score** `[P1]` — duration × consistency × stage quality, gated on HealthKit working + ≥4 nights of samples.
- **Sleep-driven Home tag** `[P2]` — "<6h → deload", ">8h + low RHR → go heavy". Fires on ≥1h delta from 7d avg.
- **Weekly AI report card** `[P2]` — Sunday push notification: "This week: 4 workouts (target 4), calories 3% over, sleep 7.1h avg. PR on Bench +5lbs." Wraps existing data, great retention hook.
- **PR celebration + shareable cards** `[P2]` — when a set beats all-time best, show celebratory modal with shareable card (body-scan card infra already exists). Optional one-tap share to iMessage.
- **Micro challenges** — "hit protein target 5 days in a row" badges. Low lift with existing data.
- **Couple/pair mode** `[P3]` — opt-in shared streak/PR view between two users. "Stacy just beat her deadlift PR." Requires backend social-graph table + privacy UI.
- **Body photo progression** `[P3]` — weekly mirror selfies, auto-aligned timeline, comparison slider. Ship 90-day visible diff.
- **Mood / stress tracking** — simple 1–5 slider at workout finish; feeds recovery readiness over time.
- **Social sharing of workouts/PRs/scans** — `react-native-view-shot` + `expo-sharing` already installed.

### Hardware / Integrations
- **Apple Watch companion app** — log sets from watch, rest-timer on wrist, heart-rate during workout. Real native work: watchOS target + WatchConnectivity bridge. Multi-day project.
- **Home-screen widgets (not Live Activities)** `[P3]` — static "today's targets / remaining calories" card. Lighter than Live Activities — no ActivityKit, just WidgetKit. Could reuse the `@bacons/apple-targets` plugin.
- **Voice logging via Siri shortcuts** `[P3]` — "Hey Siri, log a set: 185 by 8." Expose an App Intent.
- **Export to workout apps** (Hevy, Strong, FitNotes) — CSV or JSON download. Nice churn-protection: even if a user leaves, they keep their data.
- **Export to MyFitnessPal** — nutrition data. Same reason.
- **Apple Health write** — save completed Thallo workouts to HealthKit (entitlement already declared). So users' watch rings close on Thallo days.
- **Android support** — `react-native-health-connect` equivalent for Health Connect. Large lift — entire platform surface.
- **Garmin** — requires Garmin Health API business application (weeks). Apple Health bridge covers most Watch users for now.

### Polish & UX
- **Trend charts** — weight, volume, strength over time. Today there's a weight chart only. Add volume (weekly sets × reps × weight) and top-set progression per exercise.
- **Calendar view for all data** — single calendar showing workouts + meals + PRs on the same grid.
- **Exercise name inline-edit during workout** — mirror the meal-name pattern (shipped 2026-04-20 for meals).
- **PR leaderboard** — internal (just you + Stacy), opt-in display.
- **Exercise image coverage** — 32/201 exercises have wger images. Seed custom for top 50 lifts.
- **Beginner tutorials / onboarding video** — in-app 60-second walkthrough of the first workout + meal log.
- **Nutrition education micro-lessons** — rotating tips on the Foods tab ("fiber targets," "protein timing myth").

### Monetization (future)
- **Subscription infrastructure** — RevenueCat. AI features (plan generation, coach, food scan) behind paywall; deterministic features free.
- **Coach / trainer mode** — one coach sees multiple clients. Bigger business model, later.

---

## Performance & Scalability

Items ordered by cost-to-fix × impact. **Not blockers** — each pays dividends as users grow past pilot.

### Client
- **[HIGH]** Debounce `userState` pushes (batch 2–3s). Today every keystroke can trigger a full-blob POST. On a workout with 20 set logs that's 20 full writes.
- **[MEDIUM]** Lazy-load exercise library images. `Library` tab renders all 201 up-front; most users scroll ~20.
- **[MEDIUM]** Coalesce AsyncStorage writes via `multiSet` when multiple keys change in one render pass.
- **[LOW]** JS bundle size audit — haven't profiled. Run Metro bundle visualizer; look for duplicated theme defs, dead code from removed chat topic picker / workout regen fallback.
- **[LOW]** Parallelize cold-start auth sequence — `getMe` + `loadProfile` + `pullUserStateFromBackend` all block auth-to-home. Only `getMe` needs to block; stream the rest.

### Backend
- **[HIGH]** Eliminate App Runner cold starts — either **min-instances=1** (+$15–25/mo) or **warm pinger** (CloudWatch Event → `/health` every 5 min, free). Cold starts are the worst pilot UX.
- **[MEDIUM]** AI response caching — `ai_search_cache` table keyed by `(type, normalized_query)`. Cache exercise + food searches cross-user; cache recipe generation per-user. Target 60% hit rate.
- **[MEDIUM]** `progression_insights` N+1 — batch per-exercise queries into one `IN (...)` SQL or `selectinload()`.
- **[LOW]** `plan_jobs` prune hook — today on startup. Move to a daily scheduled job in case App Runner rarely restarts.
- **[LOW]** ETag on `/exercises` so client's hourly refresh is a cheap 304 instead of a serialize+transfer.
- **[LATER]** RDS Proxy in front of Postgres past ~50 concurrent users.
- **[LATER]** Materialize `progression_insights` / `fitness_score` / `health_score` to nightly rollup tables when on-demand compute gets expensive.

### Network / Infra
- **[Pre-launch]** NAT gateway reconsideration. Currently App Runner outbound Public → RDS Public with `0.0.0.0/0:5432` SG. Before opening external testing, switch back to VPC + NAT gateway (~$32/mo) so RDS goes private.
- **[LATER]** CloudFront in front of self-hosted exercise images if we move off wger.
- **[LOW]** App Runner concurrency tuning (default 100). Revisit at ~50 signups.

### Database
- **[HIGH — after 1 wk real data]** `EXPLAIN ANALYZE` every paginated endpoint with 1k rows/user seeded.
- **[MEDIUM]** Partial indexes for active-only queries (`WorkoutCompletion(user_id) WHERE workout_date >= CURRENT_DATE - 30`). Measure first.
- **[LATER]** VACUUM tuning below 10M rows.
- **[LATER]** Partition `exercise_sets` by month after sustained scale.

---

## Engineering Backlog

Open items that don't fit features or performance.

### API / Backend
- **CORS origin lockdown** — still `*` in prod env. Lock to actual client origin(s) before any public surface.
- **Production API URL** — `api.ts:15` hardcoded placeholder for non-dev. Pull from `expo-constants`.
- **Silent swallow on `/workouts/complete` persistence** — now WARNING-level, monitor after real users hit it.
- **`_ai_backfill_micros` bypasses helpers** — direct `client.chat.completions.create()` call; should route through `_chat_create` / `_build_chat_kwargs` for gpt-5 param normalization.
- **Reference ranges don't apply safety floor** — `/profile/calorie-ranges` returns raw TDEE math; doesn't clamp to 1200F/1500M like plan gen does.
- **`MIN_SAFE_CALORIES` constant inconsistent** — multiple enforcement paths. Consolidate.

### Client
- **MealEditModal reseeds on prop identity change** — unsaved edits blown away when parent re-renders with a new `meal` reference. Stabilize initial state to only reseed on actual content change.

### Ops
- **CI/CD pipeline** — no `.github/workflows/`. Add GitHub Actions for PR lint + `make test`.
- **Error reporting** — wire up Sentry / Rollbar / CloudWatch alarms.
- **Alembic migrations** — backend creates schema on startup via SQLModel. Fine for solo dev, brittle once users exist. Add before first breaking schema change.
- **Backup/restore verification** — confirm RDS backup retention ≥7 days.
- **Rotate RDS password** — was briefly shared in earlier debugging session.

---

## Storage & Retention Strategy

**Short answer:** don't prune historical data; do bound every read. Lift pagination + date filters onto list endpoints (shipped). Offset pagination is fine for launch; cursor is a later upgrade.

### Principles
- **Keep durable, user-owned data forever.** Workouts, sessions, sets, meals, items, check-ins. Deletion is irreversible.
- **Bound every read.** Force clients to page or date-filter.
- **Separate durable history from disposable cache.**
- **Retention is a product decision, not a storage one.** Plan for account deletion + data export; don't auto-prune for space.

### Tiers
**Write-forever durable:**
- `workout_sessions`, `workout_exercises`, `exercise_sets`
- `workout_completions`
- `meals`, `meal_items`
- `weekly_checkins`
- `goal_history`, `plan_change_history`
- `user_profiles`, `user_goals`, `user_preferences`

**Bounded / prunable / cache-like** (add TTLs or LRU eviction):
- `plan_jobs` — prune on success ≥7 days old (shipped)
- AI search cache (when built) — TTL-based
- Transient UI state shuttled via `userState`
- `user_recent_foods` — cap to last N per user

### userState blob guardrails
- ✅ OK: themeName, `recoveryExpanded`, routine toggles, UI prefs
- ⚠️ Borderline: 14-day `workoutHistory` skeleton (currently synced — OK because bounded)
- ❌ Avoid: full meal history, long-term plan archives, AI-generated content

1MB cap shipped. Future: make push over cap surface a clear error, not silent truncation.

### Governance (plan for launch, not today)
- **Account deletion** — soft-mark, 30-day grace, hard-delete all user-scoped rows. Shipped `DELETE /profile/account` with `{"confirmation":"DELETE"}` guard + email scramble.
- **Data export** — `GET /profile/export` returns JSON of every user row. Shipped.
- **Optional clear-history** — per-category (clear meal history separately from workout history). Nice-to-have, defer.

---

## Pre-Deploy Hardening (historical)

All P0/BLOCKER items shipped before the 2026-04-20 pilot. Kept here for audit reference.

### Shipped before pilot
- Production SECRET_KEY (64-char hex) + startup validation (≥32 chars required when DATABASE_URL is Postgres)
- Env var injection via App Runner (not baked into Docker image)
- CORS origins from env var (production should lock to specific origin pre-external-testing)
- Auth rate limiting via slowapi: 5/hr register, 10/min + 100/hr login, 3/hr reset
- Structured JSON logging with request_id / user_id contextvars
- Auth audit logging (register, login, reset — IP + email + outcome)
- Graceful shutdown hook (`engine.dispose()`)
- Password floor lifted to 10 then relaxed to 8 + digit (session decision 2026-04-20)
- Connection pool tuning: pool_size=20, max_overflow=10, pool_recycle=3600, pool_pre_ping=True
- Request-ID middleware injecting UUID per request
- Security headers: X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS
- Louder startup error logging via `logger.exception`
- Readiness probe `/ready` separate from `/health`
- API smoke test suite (17 cases, `backend/tests/test_api_smoke.py`)
- Deployment doc (`docs/DEPLOYMENT.md`)
- `plan_jobs` 7-day prune on startup
- `userState` blob cap 5MB → 1MB
- List endpoints paginated: `/workouts`, `/meals`, `/meals/history`, `/meals/common`, progression insights capped 90d
- Timezone consistency audit (datetime.utcnow → tz-aware where DB column allows)
- `GET /profile/export` for GDPR/data-portability
- `DELETE /profile/account` soft-delete with confirmation guard
- Makefile deploy targets: `make deploy`, `deploy-backend`, `deploy-ios`, `smoke-prod`

---

## Completed

### 2026-04-20 session (post-TestFlight-1 triage)
- Password rule: 10 → 8 chars (+ digit) — pilot-friendly
- `getBaseUrl` in `api.ts` ignores `app.json`'s `apiBaseUrl` in dev so local dev client hits `localhost:8000`, not prod
- Food-search client timeout 15s → 45s (App Runner cold start + OpenAI)
- `SearchInput` clear button swapped from "CLEAR" pill → `close-circle` icon (matches MealEditModal)
- Apple Health vitals card on Progress > Body Check (RHR, last night sleep, 7d steps/workouts/active cal/avg sleep)
- Apple Health Connect button flow — 3 states (not connected / connected-empty / has-data)
- Raw iOS error surfacing via `getLastHealthKitError()`
- Recovery-question auth flow — backend complete, AuthScreen two-step reset UI shipped, modal built (not yet rendered)
- `UserRead` response includes `has_recovery_question` flag
- `ensureFreshInstall()` on boot clears SecureStore JWT if AsyncStorage is empty — fixes auto-login-to-ghost-profile after reinstall
- Live Activities scaffolding: widget extension, SwiftUI UI, local Expo module, ActivityKit bridge, ActiveWorkoutScreen integration, all defensively wrapped
- `NSSupportsLiveActivities` + frequent-updates flag in app.json
- `@bacons/apple-targets` plugin added
- MealEditModal duplicate-meal bug fix: `persistNow` no longer auto-pushes for new meals
- `api.ts` `resetPassword` signature accepts answer param

### Critical (pre-pilot)
- Calorie safety floor restored (1200F / 1500M per day)
- ExerciseSet cascade delete fixed (workout_exercise_id)
- Silent exception swallowing → rollback + targeted re-raise (WARNING-level)
- Smoke-test endpoint gated behind auth
- Production SECRET_KEY (64-char hex)
- USDA API key set

### Engineering (pre-pilot)
- Error boundaries wrapping all tab content
- N+1 fixes (batch MealItem loads)
- DB indexes: WorkoutCompletion, WorkoutSession, Meal, UserGoal
- UserState blob size validation (now 1MB)
- Response models on fatigue, workout status, nutrition score
- Print → logger in workouts.py, planner.py, weekly_recipe.py
- 10 test modules (183 tests) registered
- `aiWorkoutPlan` + `workoutHistory` in SYNCED_STATE_KEYS
- `GET /workouts/completions` for skeleton hydration
- Cold-start hydration from backend when local empty
- `POST /workouts/sync` per-set persistence (debounced 1.5s)
- Equipment enum coercion in `/workouts/complete` + `/workouts/sync`
- Atomic signup (token only after onboarding completes)
- Exit signup → auth screen with state reset
- OpenAI SDK 2.31: `reasoning_effort="minimal"` string param
- Splash teal shimmer sweep

### Fitness Domain
- Systemic fatigue decay extended to 5 days
- Strength reps 3–5, endurance 15–20, short interval rest 120s
- Muscle gain at 3 days: full body preferred over PPL
- Recovery/mobility days: negative fatigue
- Two-pass fatigue (accumulation → recovery, max 1/day, 15% proportional, capped 0.15)
- Recovery stacking prevention
- Fatigue floor clamped at 0.0
- Recovery day allocation separate from conditioning
- Recovery/mobility scaling to session_minutes
- Injury system 3-layer (block / recover / fatigue) with expanded body parts
- Focus auto-correction via muscles on completion
- Exercise dislike (thumbs down, plan-excluded)
- Multi-completions per day (upsert key includes focus)
- Compound Strength: 5 sets primary, 4 min rest, UL only
- Marathon goal enabled
- Glute isolation on lower days, vertical pull on upper heavy
- Injury button approval + chat clears after
- Injury auto-save to AsyncStorage
- Injury boost capped at injury level
- `focus_override` on fresh-day gen

### Nutrition Domain
- Micronutrient backfill (no 20-item cap)
- Iron RDA sex-aware
- Endurance protein comment fixed
- USDA household-text parser (tbsp→15g, cup→240g)
- Allergen filter: 8 categories
- Meal history: 6 fns, 5 endpoints, auto-log on check-off
- Nutrition recovery integration (4 protein tiers)
- Low protein penalty + insight message
- Nutrition score tags with actual ratio + actionable gap
- Score detail view (adherence/quality/micro bars)
- Combined Health Score on Progress using real meal averages
- "YOUR FAVORITES" common meals on Foods tab
- Food search source badges (USDA green / AI purple)
- Food conversion ratio=1 across weight↔volume
- Shrimp/prawn/salmon/tuna/tilapia density lookup
- Rolling averages denominator = window days
- Hydration: client score + water target

### AI / Coach
- Unified coach chat (topic picker removed)
- gpt-5-mini migration for scanning endpoints
- `_build_chat_kwargs` with `max_completion_tokens` + `reasoning_effort=minimal`
- Direct OpenAI calls in scanning.py through helpers
- Plan update approval: chat auto-close 1.5s after applying
- Short replies ("Yes"/"Sure") allowed mid-conversation
- Injury AI returns structured `updated_injuries`
- Image MIME fix for HEIC via Pillow

### Polish / UX
- Meal name inline-editable at card level
- Theme classifications fixed (Blossom/Slate Dark, Sunrise/Arctic Light)
- New light themes: Linen & Olive, Mint Fresh (29 total)
- PDF export via expo-print (themed, two-column, Thallo logo)
- Export moved to Progress > History
- Workout sub-tabs: Plan / Library / Settings
- Meals sub-tabs: Plan / Foods / Supps
- Library tab exercises/muscles toggle
- Injuries in Workout Settings
- Body part picker with muscle mapping
- Per-day nutrition scores on card headers
- Food quality dots (green/red/gray)
- Resume workout themed modal (only when sets logged)
- Rest timer AI badge prominent
- Stretches/bodyweight hide weight column
- AppState timer catch-up on foreground
- Workout start time persists to AsyncStorage
- Barcode scanner ref lock
- Meal edits auto-persist
- Saved meals no longer rejected by micros check
- Spin Class + Pilates subtypes
- "Overall Load" label replaces "CNS / Systemic"
- Active activities: Yard Work, Chopping Wood, Moving, Gardening, House Cleaning, Construction, Shoveling, Playing w/ Kids, Dancing
- Sports: Pickleball, Surfing, Skiing

---

## Feature Matrix

| Feature | Status |
|---------|--------|
| Auth (login/signup, 8+digit password, forgot password via recovery question) | Done |
| Onboarding (5 steps, atomic — exit cleans up) | Done |
| Training day selector | Done |
| Goal selection (11 goals + HYROX + Marathon) | Done |
| Deterministic workout planner | Done |
| Per-day generation with history | Done |
| Day swap (deterministic UI + generated recovery/mobility/cardio) | Done |
| Active workout tracking + per-set backend sync | Done |
| Timed exercise support | Done |
| Exercise images from wger.de | Partial (32/201) |
| Exercise search (wger + AI) | Done |
| Exercise dislike (thumbs down) | Done |
| 12-muscle-group fatigue + extended CNS decay | Done |
| Two-pass recovery (proportional, capped, no stacking) | Done |
| Negative fatigue for recovery/mobility | Done |
| Nutrition recovery integration (4 protein tiers + penalty) | Done |
| Recovery readiness + muscle bars + nutrition insight | Done |
| Progressive overload display | Done (needs deload) |
| Set programming (warmup/heavy/backoff) | Done |
| In-workout AI set review | Done |
| Manual activity logging | Done |
| Multiple completions per day | Done |
| Recovery/mobility scaling (time-budget) | Done |
| Weight tracking | Done |
| Food search (USDA + AI) | Done |
| Barcode scanning | Done |
| Meal planning (AI) | Done |
| Meal name inline rename | Done |
| Food photo scanning | Done |
| Meal history system | Done |
| Common meals UI | Done |
| Nutrition scoring | Done |
| Combined health score (14-day) | Done |
| Food quality classification | Done |
| AI coach (unified) | Done |
| Body scan (AI) | Done |
| Injury tracking (3-layer) | Done |
| Progress history + PRs | Done |
| Data export (PDF + JSON) | Done |
| 29 themes | Done |
| Weekly check-in | Done |
| Push notifications (permission only) | Partial |
| **Local notification scheduling** | **Not built** |
| Splash screen (shimmer sweep) | Done |
| Error boundaries | Done |
| Calorie safety floor | Done |
| Database indexes | Done |
| Response models | Done |
| Automated test suite (183 tests) | Done |
| **Apple Health read** | **Blocked on entitlement** |
| **Apple Health vitals display** | **Coded, blocked on above** |
| **Apple Watch workout auto-import** | **Not wired** |
| **Live Activities (rest timer on lock screen)** | **Scaffolded, build iteration** |
| **Recovery question modal (post-login)** | **Backend done, modal unrendered** |
| **Sleep score** | **Not built (blocks on HealthKit)** |
| **Sleep-driven engagement tag** | **Not built** |
| **Weekly AI report card** | **Not built** |
| **PR celebration card** | **Not built** |
| **Meal-prep / grocery list** | **Not built** |
| **Body measurements (waist/hips/etc)** | **Not built** |
| Apple Health write | Not wired |
| CI/CD | Not configured |
| Subscription/paywall | Not built |
| AI search result cache | Not built |
| Android support | Not built |
