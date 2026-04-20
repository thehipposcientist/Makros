# Thallo — Recommendations & Roadmap

Last updated: 2026-04-20

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

#### `list_meals` Unbounded Without Date
`GET /meals` returns everything when no date filter is provided. Add a sensible default cap (e.g. last 90 days) or require a date range.

#### `get_common_meals` No Date Limit
Same pattern — scans the entire history. Cap the lookback window.

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
