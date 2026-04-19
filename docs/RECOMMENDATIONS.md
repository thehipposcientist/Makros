# Thallo — Recommendations & Roadmap

Last updated: 2026-04-19

---

## Critical — Fix Before Any Deploy

### ~~1. Restore Calorie Safety Floor~~ DONE
Per-day minimum enforced: 1200 kcal female, 1500 kcal male. Applied to final daily target, not per-meal.

### ~~2. Fix Orphaned ExerciseSet Cascade Delete~~ DONE
Changed `ExerciseSet.exercise_id` → `ExerciseSet.workout_exercise_id` in the delete endpoint.

### ~~3. Silent Exception Swallowing in Workout Persistence~~ DONE
Now logs error, calls `db.rollback()`, re-raises `IntegrityError` for critical DB failures. Non-critical errors still swallowed.

### ~~4. Unauthenticated Smoke-Test Endpoint~~ DONE
Added `current_user: User = Depends(get_current_user)` to `GET /ai/smoke-test`.

### ~~5. Production SECRET_KEY~~ DONE
64-character random hex string generated and set in `backend/.env`.

### ~~6. Get USDA API Key~~ DONE
Production key set in `backend/.env`.

---

## High — Engineering

### ~~7. Add Error Boundaries~~ DONE
`ErrorBoundary` component created. Wraps workout, meals, progress, and profile tab content in HomeScreen.

### ~~8. Fix N+1 Queries~~ DONE
Batch `MealItem` queries using `meal_id.in_(meal_ids)` + `defaultdict` grouping in `meals.py` (list_meals, daily_summary) and `meal_history.py` (get_meal_history, get_rolling_averages, get_common_meals, get_nutrition_patterns).

### ~~9. Add Missing Database Indexes~~ DONE
Added composite indexes: `WorkoutCompletion(user_id, workout_date, focus_label)`, `WorkoutSession(user_id, workout_date)`, `Meal(user_id, meal_date)`, `UserGoal` partial unique index on `(user_id) WHERE is_active = true`.

### ~~10. Validate UserState Blob Size~~ DONE
`UserStateBody` Pydantic model with `field_validator` rejects state blobs > 5MB. Client updated to wrap state in `{ state }`.

### ~~11. Add Response Models to Endpoints~~ DONE
Added `WorkoutStatusResponse`, `FatigueScoreResponse`, `NutritionScoreResponse` Pydantic models to key endpoints.

### 12. Production API URL
`api.ts:15` — hardcoded placeholder `'https://your-production-api.com'`. Must be an env var via `expo-constants`.

### ~~13. Password Strength Validation~~ DONE
`UserCreate.password` now has `Field(min_length=8)`. Short passwords get 422 at validation.

### ~~14. Replace Print Statements with Logger~~ DONE
`workouts.py`, `planner.py`, `weekly_recipe.py` — all `print()` replaced with `logger.debug()` / `logger.info()`.

### ~~15. Register All Test Modules~~ DONE
All 10 test modules (183 tests) now registered in `run_all.py`.

---

## High — Fitness Domain

### ~~16. Extend Systemic Fatigue Decay Window~~ DONE
Extended to 5 days for systemic (CNS): days 4=0.05, 5=0.02. Non-systemic muscles still zero after day 3.

### 17. Add Deload / Periodization Mechanism
No deload weeks, no volume periodization, no block structure. At minimum, add auto-deload after 4 weeks of progressive loading.

### ~~18. Fix Strength Prescription Reps~~ DONE
Changed strength primary compound reps from "4-6" to "3-5".

### ~~19. Fix Endurance Strength-Maintenance Prescription~~ DONE
Changed endurance primary to "15-20" reps at 45s rest. Secondary to "12-15" at 45s. Isolation to "15-20" at 30s.

### ~~20. Add Glute Isolation to Standard Lower Days~~ DONE
Added Glute Isolation slot to `_lower_slots` (all 3 cycles), `_legs_slots`, `_lower_hypertrophy_slots`, `_legs_volume_slots`.

### ~~21. Add Vertical Pull to Upper Heavy~~ DONE
Added `Slot("Vertical Pull", "vertical_pull", "back", "secondary")` to `_upper_heavy_slots`.

### ~~22. Fix Short Interval Rest Ratios~~ DONE
Changed COND_INTERVALS_SHORT rest from 75s to 120s (1:3 work:rest ratio).

### ~~23. Muscle Gain at 3 Days — Frequency Too Low~~ DONE
Full body split now preferred at ≤3 days for muscle_gain (+12 score bonus). PPL bonus removed at 3 days.

### 24. HYROX Missing Tempo Running at Low Day Counts
3-day HYROX needs at least one dedicated running tempo session.

### 25. Cap Zone 2 Duration
Z2 can reach 70 minutes. Cap at 45-50 for recreational users.

---

## High — Nutrition Domain

### ~~26. Fix Nutrition Score Micronutrient Pipeline~~ DONE
Removed 20-item cap on micro backfill — now batches all items in groups of 20. All plan items get micronutrient enrichment.

### ~~27. Iron RDA is Sex-Blind~~ DONE
Both backend `compute_nutrition_score(sex=)` and client `computeNutritionScore(plan, goal, sex)` now accept sex parameter. Male = 8mg iron RDA, female/unknown = 18mg.

### ~~28. Hydration Bonus + Daily Water Target~~ DONE
Added hydration infrastructure to client score. Created `hydration.ts` utility with `dailyWaterOz`/`formatWaterTarget` based on bodyweight + workout duration. Water recommendation shown on meals Plan tab.

### ~~29. Endurance Protein Comment Incorrect~~ DONE
Fixed comment to "0.8 g/lb = 1.76 g/kg — above ACSM minimum of 1.2 g/kg".

### ~~30. USDA Serving Size 100g Fallback~~ DONE
Added `_parse_household_grams()` with unit→grams mapping (tbsp=15g, cup=240g, oz=28g, etc.). Falls back to 100g only if parsing fails.

### ~~31. Allergen Filter~~ DONE
New `allergen_filter.py` with `filter_allergens()` checking 8 categories (peanuts, tree_nuts, dairy, gluten, soy, eggs, shellfish, fish). Called after AI meal generation in both plan paths. Removes matching items and logs warnings.

---

## Medium — Polish

### ~~32. Accessibility Labels~~ DONE
Added ~15 labels to key elements: bottom tabs (role="tab" + selected state), Coach button, Start/Finish Workout, log-set badges, timer controls, meal checkboxes, edit buttons.

### 33. Apple Health Auto-Import
Code exists for reading. Missing: auto-import workouts into fatigue system.

### ~~34. Coach Memory Pagination~~ DONE
SQL LIMIT added to query. Default 10, max 50. Python-side slicing removed.

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

## Recently Completed

| Change | Status |
|--------|--------|
| Calorie safety floor restored (1200F / 1500M per day) | Done |
| ExerciseSet cascade delete fixed (workout_exercise_id) | Done |
| Silent exception swallowing → rollback + targeted re-raise | Done |
| Smoke-test endpoint gated behind auth | Done |
| Production SECRET_KEY generated (64-char hex) | Done |
| USDA API key set | Done |
| Error boundaries wrapping all tab content | Done |
| N+1 queries fixed (batch MealItem loads in meals.py + meal_history.py) | Done |
| Database indexes added (WorkoutCompletion, WorkoutSession, Meal, UserGoal) | Done |
| UserState blob size validation (5MB limit) | Done |
| Response models on fatigue, workout status, nutrition score endpoints | Done |
| Password validation (min 8 chars) | Done |
| Print → logger in workouts.py, planner.py, weekly_recipe.py | Done |
| All 10 test modules (183 tests) registered in `run_all.py` | Done |
| Recovery/mobility days: negative fatigue (active recovery) | Done |
| Two-pass fatigue: positive accumulation then recovery (max 1/day, 15% proportional, capped 0.15) | Done |
| Recovery stacking prevention (5 saunas = same as 1) | Done |
| Fatigue floor clamped at 0.0 | Done |
| Recovery day allocation separate from conditioning in weekly recipe | Done |
| Recovery/mobility day scaling to session_minutes (time-budget picker) | Done |
| Mobility/recovery bypass slot system → use dedicated time-aware generators | Done |
| WorkoutCard time estimator handles "each side" doubling + slow reps | Done |
| Injury system: 3-layer (block, recover, fatigue) with expanded body parts | Done |
| Focus auto-correction via `_infer_focus_from_muscles()` on workout completion | Done |
| Exercise dislike feature (thumbs down, excluded from plans) | Done |
| Multiple completions per day: upsert key changed to (user, date, focus) | Done |
| Meal history system: 6 functions, 5 endpoints, auto-log on check-off | Done |
| Nutrition recovery integration: `nutrition_context` on fatigue endpoint (4 protein tiers) | Done |
| Low protein penalty (+3% fatigue) + insight message on recovery card | Done |
| Nutrition score tags: actual ratio + directional messaging + actionable gap | Done |
| Score detail view: tappable card with adherence/quality/micro bars | Done |
| Health Score on Progress: real meal data via `getMealAverages` (cal 40 + pro 35 + consistency 25) | Done |
| Common meals "YOUR FAVORITES" horizontal scroll on Foods sub-tab | Done |
| Active activities category: Yard Work, Chopping Wood, Moving, etc. | Done |
| Sport expanded: Pickleball, Surfing, Skiing | Done |
| All activity types mapped in `activity_impact.py` with keyword fallbacks | Done |
| "Overall Load" label replaces "CNS / Systemic" in recovery card | Done |
| PDF export via expo-print (themed HTML, two-column, Thallo logo, username+date filename) | Done |
| Export moved from Profile tab to Progress > History tab | Done |
| Plan generation loop fix: staleness check, AsyncStorage persistence, race condition prevention | Done |
| Fresh day flag no longer cleared on initial mount (tracks previous values) | Done |
| `food_quality` field persisted on MealItem | Done |
| Image MIME fix (`_fix_image_mime` for HEIC via Pillow) | Done |
| Missing `from sqlmodel import select` import in `history.py` fixed | Done |
| Workout sub-tabs: Plan / Library / Settings | Done |
| Meals sub-tabs: Plan / Foods / Supps (Targets merged into Foods) | Done |
| Equipment section collapsible with card-style header | Done |
| Foods section collapsible | Done |
| Library tab has exercises/muscles toggle inside | Done |
| Injuries moved from Goal tab to Workout Settings tab | Done |
| Injury body part picker (not free text) with muscle group mapping | Done |
| Per-day nutrition scores on NutritionCard headers | Done |
| Food quality dots on meal items (green/red/gray) | Done |
| Resume workout: themed modal, only shows if sets logged | Done |
| Rest timer AI badge prominent (16px bold on accent bg) | Done |
| Stretches/bodyweight exercises hide weight column | Done |
| AppState listener for timer catch-up on foreground return | Done |
| Workout start time persists to AsyncStorage | Done |
| Barcode scanner ref-based lock prevents multiple scans | Done |
| Meal edits auto-persist to AsyncStorage | Done |
| Saved meals no longer rejected by micros check on reload | Done |
| Routine overlay skipped for saved/remote plans | Done |
| Spin Class + Pilates activity subtypes | Done |
| AI coach button toned down (surface bg, outline icon) | Done |
| Splash screen cleaned up (no duplicate logo, proper square icon) | Done |
| Manual activity history shows full detail ("Recovery · Sauna (easy)") | Done |
| Serving display: "1 serving (~200g)" for vague units | Done |
| Dark theme fixes: MealEditModal text, image placeholders, skeleton loader | Done |
| Systemic fatigue decay extended to 5 days (0.05/0.02 for days 4-5) | Done |
| Strength prescription: "3-5" reps for pure strength | Done |
| Endurance maintenance: "15-20" reps at 45s rest | Done |
| Short interval rest: 120s (1:3 ratio) | Done |
| Muscle gain at 3 days: full body preferred over PPL | Done |
| Micronutrient backfill: no 20-item cap, batches all items | Done |
| Iron RDA sex-aware: male=8mg, female=18mg (backend + client) | Done |
| Endurance protein comment fixed (1.76 g/kg) | Done |
| USDA serving size: household text parser (tbsp→15g, cup→240g, etc.) | Done |
| Allergen filter: 8 categories, runs post-AI generation | Done |
| Accessibility labels on ~15 key interactive elements | Done |
| Coach memory: SQL LIMIT (default 10, max 50) | Done |
| Glute isolation added to all standard lower/legs day templates | Done |
| Vertical pull added to upper heavy slots | Done |
| Hydration: client score infrastructure + `hydration.ts` utility + water target on meals tab | Done |
| Coach timeout: `askWorkoutQuestion` increased to 60s | Done |
| Coach capabilities hint in empty chat (6 categories + description) | Done |
| Active workout coach placeholder: "Ask about form, weight, alternatives, or pain..." | Done |

---

## Technical Debt Summary

| Issue | Severity | Effort |
|-------|----------|--------|
| ~~Calorie safety floor~~ | ~~Critical~~ | ~~DONE~~ |
| ~~ExerciseSet cascade delete~~ | ~~Critical~~ | ~~DONE~~ |
| ~~Silent exception swallowing~~ | ~~Critical~~ | ~~DONE~~ |
| ~~Unauthenticated smoke-test~~ | ~~Critical~~ | ~~DONE~~ |
| ~~N+1 queries~~ | ~~High~~ | ~~DONE~~ |
| ~~Missing DB indexes~~ | ~~High~~ | ~~DONE~~ |
| ~~No error boundaries~~ | ~~High~~ | ~~DONE~~ |
| ~~Password validation~~ | ~~Medium~~ | ~~DONE~~ |
| ~~Print → logger~~ | ~~Medium~~ | ~~DONE~~ |
| ~~Response models~~ | ~~Medium~~ | ~~DONE~~ |
| ~~Systemic fatigue decay~~ | ~~High~~ | ~~DONE~~ |
| No deload mechanism | High | 4 hrs |
| ~~Iron RDA sex-blind~~ | ~~High~~ | ~~DONE~~ |
| ~~Strength/endurance prescription~~ | ~~High~~ | ~~DONE~~ |
| ~~Short interval rest ratio~~ | ~~High~~ | ~~DONE~~ |
| ~~Muscle gain 3-day frequency~~ | ~~High~~ | ~~DONE~~ |
| ~~Micro backfill cap~~ | ~~High~~ | ~~DONE~~ |
| ~~Allergen filter~~ | ~~High~~ | ~~DONE~~ |
| ~~USDA 100g fallback~~ | ~~Medium~~ | ~~DONE~~ |
| ~~Accessibility labels~~ | ~~Medium~~ | ~~DONE~~ |
| ~~Coach memory pagination~~ | ~~Medium~~ | ~~DONE~~ |
| Production API URL hardcoded | Medium | 15 min |

---

## Feature Completeness

| Feature | Status |
|---------|--------|
| Auth (login/signup, min 8 char password) | Done |
| Onboarding (5 steps, compressed) | Done |
| Training day selector | Done |
| Goal selection (10 goals + HYROX) | Done |
| Deterministic workout planner | Done |
| Per-day generation with history | Done |
| Day swap (deterministic UI + generated recovery/mobility/cardio) | Done |
| Active workout tracking | Done |
| Timed exercise support | Done |
| Exercise images from wger.de | Done (32/201) |
| Exercise search (wger + AI) | Done |
| Exercise dislike (thumbs down) | Done |
| 12-muscle-group fatigue system | Done (needs extended CNS decay) |
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
| Food search (USDA + AI) | Done |
| Barcode scanning | Done |
| Meal planning (AI) | Done |
| Food photo scanning | Done |
| Meal history system (auto-log, averages, common, insights) | Done |
| Common meals "YOUR FAVORITES" UI | Done |
| Nutrition scoring (client-side + real meal data + detail view) | Done |
| Combined health score (14-day backward-looking, activity + nutrition) | Done |
| Food quality classification | Done |
| AI coach (unified) | Done |
| Body scan (AI) | Done |
| Injury tracking (3-layer, body part picker, AI recovery estimation) | Done |
| Progress history + PRs | Done |
| Data export (PDF via expo-print, themed) | Done |
| 27 themes | Done |
| Weekly check-in | Done |
| Push notifications | Done |
| Splash screen (proper icon, no duplicate) | Done |
| Error boundaries | Done |
| Calorie safety floor (1200F/1500M) | Done |
| Database indexes | Done |
| Response models | Done |
| Automated test suite | 10 modules, 183 tests |
| CI/CD | Not configured |
| Apple Health write | Not wired |
| Subscription/paywall | Not built |
