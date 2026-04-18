# Thallo — Recommendations & Roadmap

Last updated: 2026-04-18 (post-comprehensive review)

---

## Critical — Fix Before Any Deploy

### 1. Restore Calorie Safety Floor
`calorie_calculator.py:593-597` — the 1200 kcal minimum was removed "per product decision." A 120 lb sedentary woman on aggressive fat-loss gets ~700 kcal/day. This is medically dangerous. Restore `MIN_SAFE_CALORIES` enforcement immediately. Consider sex-aware floors (1200F / 1500M).

### 2. Fix Orphaned ExerciseSet Cascade Delete
`workouts.py:778` queries `ExerciseSet.exercise_id` which doesn't exist — the correct FK is `workout_exercise_id`. Workout session deletes leave all set rows orphaned in the database. Silent data leak.

### 3. Silent Exception Swallowing in Workout Persistence
`workouts.py:542-543` — bare `except Exception` on the structured workout persistence block. A partial commit can corrupt database state. Replace with targeted exception handling and rollback.

### 4. Unauthenticated Smoke-Test Endpoint
`chat.py:23-57` — `GET /ai/smoke-test` has no auth guard. Leaks model name, OpenAI config status, and base URL in production. Gate behind `get_current_user` or remove.

### 5. Production SECRET_KEY
Generate a real 64-character random string for `backend/.env`.

### 6. Get USDA API Key
Go to https://fdc.nal.usda.gov/api-key-signup. Currently rate-limited on DEMO_KEY.

---

## High — Engineering

### 7. Add Error Boundaries
Zero React error boundaries anywhere. An uncaught render error in HomeScreen (which composes Progress + EditProfile inline) crashes the entire app. Add `<ErrorBoundary>` wrapping each tab body.

### 8. Fix N+1 Queries
- `meals.py:117,149-155` — one `SELECT meal_items` per meal in a loop
- `workouts.py:97-111` — two SELECTs per completed session for progression
- `workouts.py:703` — unbounded session list with nested queries per session
Fix with JOINs or `WHERE id IN (...)` batch fetches.

### 9. Add Missing Database Indexes
- `WorkoutCompletion` needs composite index on `(user_id, workout_date)` — currently full table scan on every workout write/status check
- `WorkoutSession` same issue
- `UserGoal` needs partial unique index: `UNIQUE (user_id) WHERE is_active = true` to prevent concurrent duplicate active goals

### 10. Validate UserState Blob Size
`profile.py:490-507` — `put_user_state` accepts unbounded `dict` body with no size limit. Add a Pydantic model with byte-size validation.

### 11. Add Response Models to Endpoints
Only auth endpoints have `response_model`. All others return raw dicts — no outgoing validation, no useful OpenAPI docs. Add Pydantic response models to all routers.

### 12. Production API URL
`api.ts:15` — hardcoded placeholder `'https://your-production-api.com'`. Must be an env var via `expo-constants`.

### 13. Password Strength Validation
`UserCreate` has no `min_length` or complexity rules. A user can register with a single character.

### 14. Replace Print Statements with Logger
`workouts.py` has ~8 `print(f"[generate-day] ...")` calls with internal state details. Use `logging.debug()`.

### 15. Register All Test Modules
`run_all.py` only includes 7 of 10 test files. `test_workout_goals`, `test_focus_differentiation`, `test_workout_archetypes` (60 tests) are silently skipped by `make test`.

---

## High — Fitness Domain

### 16. Extend Systemic Fatigue Decay Window
`activity_impact.py:18` — 3-day decay for all muscles including systemic (CNS). Heavy squat/deadlift sessions produce CNS suppression for 72-96h. Systemic should decay over 5-6 days. A heavy session from 4 days ago currently contributes zero fatigue.

### 17. Add Deload / Periodization Mechanism
No deload weeks, no volume periodization, no block structure (accumulation -> intensification -> realization). The fatigue system resets every 3 days by design with no multi-week accumulation tracking. At minimum, add auto-deload after 4 weeks of progressive loading.

### 18. Fix Strength Prescription Reps
`planner.py:824-826` — strength primary compounds prescribe "4-6" reps. The goal-bucket path diverges from the stimulus prescriber at `prescriptions.py:140` which correctly uses "3-5". Upper bound should be 5 for pure strength.

### 19. Fix Endurance Strength-Maintenance Prescription
`planner.py:863-877` — endurance maintenance prescribes "6-10" reps at 2min rest (hypertrophy range). True muscular endurance uses 15-20+ reps at 30-60s rest.

### 20. Add Glute Isolation to Standard Lower Days
`slots.py:279-290` — lower hypertrophy has quad + hamstring isolation but no glute isolation. Only specialized glute-focused templates include it. Most users doing PPL or Upper/Lower miss dedicated glute work.

### 21. Add Vertical Pull to Upper Heavy
`slots.py:241-250` — upper heavy has horizontal pull but no vertical pull (pull-ups/lat pulldown). Missing one of the primary CNS-expensive upper-body movements.

### 22. Fix Short Interval Rest Ratios
`prescriptions.py:227-228` — 30-45s work with 75s rest (1:2 ratio). For near-maximal short intervals, 1:3 to 1:4 is evidence-based. Later sets accumulate excessive fatigue at 1:2. Sprint prescription correctly uses 1:8.

### 23. Muscle Gain at 3 Days — Frequency Too Low
`goal_profiles.py:108-115` — anchors PPL at 3 days, giving 1x/week frequency per muscle group. Evidence supports 2x/week for hypertrophy. Consider anchoring full-body at 3 days.

### 24. HYROX Missing Tempo Running at Low Day Counts
`weekly_recipe.py:531` — 3-day HYROX recipe substitutes full-body lifting for what should be a run-focused day. HYROX demands at least one dedicated running tempo session even at 3 days.

### 25. Cap Zone 2 Duration
`prescriptions.py:217-218` — Z2 can reach 70 minutes. For recreational users in an app-generated plan, cap at 45-50 minutes.

---

## High — Nutrition Domain

### 26. Fix Nutrition Score Micronutrient Pipeline
Client-side scoring (`nutritionScore.ts`) only gets micronutrients from `MealItem.micronutrients` field, which is rarely populated because:
- AI-generated meals don't include micronutrients
- USDA foods may have them but they're not persisted to the plan items
- Food quality classification is keyword-based on client vs category-based on backend

The score always shows "Micronutrient coverage: low" and the quality sub-score is depressed because it can't count whole-food % without category data. See fix plan in the test document.

### 27. Iron RDA is Sex-Blind
`nutrition_score.py:30` — uses 18mg universally (female RDA). Male RDA is 8mg. A man at 10mg iron gets flagged as deficient when he's above his actual RDA.

### 28. Hydration Bonus Missing from Client Score
`nutritionScore.ts` omits the 10-point hydration bonus that `nutrition_score.py:207` includes. Scores can diverge by up to 4 points.

### 29. Endurance Protein Comment Incorrect
`goal_params.py:198-199` — comment says "1.2-1.4 g/kg (~0.55-0.65 g/lb)" but the actual value 0.8 g/lb = 1.76 g/kg.

### 30. USDA Serving Size 100g Fallback
`usda_fdc.py:73-74` — when gram weight is absent, defaults to 100g. "1 tbsp" oil at 100g overstates macros ~6x.

### 31. Allergen Filter is AI-Only
No programmatic allergen filter in meal assembly. The safety net is entirely AI-dependent. Add a hard filter on known allergens at the food selection stage.

---

## Medium — Polish

### 32. Accessibility Labels
Only 3 `accessibilityLabel` instances in the entire app. Every interactive element is invisible to screen readers. App Store compliance risk.

### 33. Apple Health Auto-Import
Code exists for reading. Missing: auto-import workouts from Apple Watch/WHOOP into fatigue system.

### 34. Coach Memory Pagination
`profile.py:381-392` — unbounded query, Python-side slicing. Add SQL LIMIT.

### 35. Workout-Aware Macro Adjustment
Currently shows tips. Phase 2: adjust actual macro targets by +/-10% on hard vs rest days.

### 36. Social Sharing
`react-native-view-shot` + `expo-sharing` installed. Let users share PRs, body scans.

### 37. Exercise Image Coverage
32/201 exercises have wger images.

---

## Lower Priority — Future

### 38. Subscription Infrastructure
RevenueCat for managing subscriptions. AI features behind paywall; deterministic features stay free.

### 39. Android Support
`react-native-health` is iOS only. Need `react-native-health-connect` for Android.

### 40. Direct Garmin API
Requires Garmin Health API business application (weeks). Apple Health bridge covers most users.

### 41. CI/CD Pipeline
No `.github/workflows/`. Tests only run if developer manually runs `make test`. Add GitHub Actions for PR checks.

---

## Technical Debt Summary

| Issue | Severity | Effort |
|-------|----------|--------|
| Calorie safety floor disabled | Critical | 10 min |
| ExerciseSet cascade delete broken | Critical | 10 min |
| Silent exception swallowing | Critical | 20 min |
| Unauthenticated smoke-test | Critical | 5 min |
| N+1 queries (3 locations) | High | 2 hrs |
| Missing DB indexes | High | 30 min |
| No error boundaries | High | 1 hr |
| Systemic fatigue decay too short | High | 30 min |
| No deload mechanism | High | 4 hrs |
| Nutrition score micronutrient pipeline | High | 2 hrs |
| Iron RDA sex-blind | High | 30 min |
| Strength/endurance prescription mismatch | High | 30 min |
| Password validation | Medium | 15 min |
| Print -> logger | Medium | 30 min |
| Accessibility labels | Medium | 4 hrs |
| Response models on endpoints | Medium | 3 hrs |
| Test module registration | Medium | 5 min |
| USDA 100g fallback | Medium | 30 min |

---

## Feature Completeness

| Feature | Status |
|---------|--------|
| Auth (login/signup) | Done |
| Onboarding (5 steps, compressed) | Done |
| Training day selector | Done |
| Goal selection (10 goals + HYROX) | Done |
| Deterministic workout planner | Done |
| Per-day generation with history | Done |
| Day swap (deterministic UI) | Done |
| Active workout tracking | Done |
| Timed exercise support | Done |
| Exercise images from wger.de | Done (32/201) |
| Exercise search (wger + AI) | Done |
| 12-muscle-group fatigue system | Done (needs extended CNS decay) |
| Recovery readiness + muscle bars | Done |
| Progressive overload display | Done (needs deload) |
| Manual activity logging | Done |
| Weight tracking (unified) | Done |
| Food search (USDA + AI) | Done |
| Barcode scanning | Done |
| Meal planning (AI) | Done |
| Food photo scanning | Done |
| Nutrition scoring (client-side) | Done (micronutrient pipeline needs fix) |
| Combined health score | Done |
| AI coach (unified) | Done |
| Body scan (AI) | Done |
| Progress history + PRs | Done |
| Data export (CSV) | Done |
| 27 themes | Done |
| Weekly check-in | Done |
| Push notifications | Done |
| Splash screen | Done |
| Automated test suite | Partial — 181 unit tests, no integration/frontend |
| Error boundaries | Not built |
| CI/CD | Not configured |
| Apple Health write | Not wired |
| Subscription/paywall | Not built |
