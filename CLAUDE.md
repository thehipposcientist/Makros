# Thallo — CLAUDE.md

## Project Overview
Thallo is a premium fitness + nutrition app. React Native (Expo) client, FastAPI backend. Users complete onboarding (goal, schedule, equipment, foods), then get a deterministic workout plan + AI-skeleton/deterministic-enriched nutrition plan. The app tracks workouts, meals, weight, fatigue, and recovery — adapting recommendations based on real training + eating data.

## Tech Stack
- **Frontend**: React Native 0.81.5 / Expo SDK ~54 / expo-router v6 / TypeScript
- **Backend**: FastAPI + SQLModel + PostgreSQL 16 (Docker)
- **AI**: OpenAI `gpt-4o-mini` (configurable via env) for meal skeletons, trainer coach, food scanning, in-workout set review, food classification fallback
- **Workout planner**: Fully deterministic — no AI in exercise selection, split choice, or weekly recipe
- **External data**: USDA FoodData Central (food nutrition, incl. added sugars #1235), wger.de (exercise images/search)

## Architecture

### Workout System (Deterministic)
```
User Profile -> GoalProfile -> WeeklyRecipe -> DayArchetype -> Slots -> ExerciseSelection -> Prescription
```
- `goal_profiles.py` — maps goals to training mix (strength/hypertrophy/power/conditioning/mobility/recovery), allowed archetypes, planner mode (lifting, lifting_plus_cardio, strength, endurance, athletic, hyrox, maintain, mobility, recovery). Longevity / healthy_aging / heart_health route to general_health via `_PROFILE_OVERRIDES`. All hybrid-preferring goals (muscle_gain, body_recomp, fat_loss, general_health, strength, athletic_performance) list the `LIFT_*_PLUS_CARDIO` archetypes in `allowed_archetypes`.
- `weekly_recipe.py` — generates weekly archetype sequence. `_lifting_plus_cardio_recipe` for body_recomp/fat_loss/endurance; `_lifting_recipe` + direct hybrid injection for muscle_gain/strength/general_health; plus `_endurance_recipe`, `_athletic_recipe`, `_hyrox_recipe`, `_maintain_recipe`, `_mobility_recipe`, `_recovery_recipe`. `_inject_hybrid_cardio` promotes N lift days to PLUS_CARDIO per the goal × days table (runs AFTER adjacency repair + intensity spacing so repair can't choke on hybrid archetypes — PLUS_CARDIO shares focus_family with its base lift so adjacency is preserved).
- `archetypes.py` — every day archetype lives here. `LIFT_*` (plus stimulus-differentiated heavy/hypertrophy/volume variants), `COND_*`, `MOBILITY_*`, `RECOVERY_*`, `HYBRID_*`, and the v3 `LIFT_PUSH_PLUS_CARDIO / LIFT_PULL_PLUS_CARDIO / LIFT_UPPER_PLUS_CARDIO / LIFT_FULL_BODY_PLUS_CARDIO` (lift day + cardio finisher). PLUS_CARDIO are categorized as `lift` (not `hybrid`) because they're structurally lift days; training_type="mixed" so the prescription dispatcher routes cardio rows to cardio prescription and lift rows to lift prescription. They're explicitly excluded from `_is_heavy` so they don't trip the heavy-streak guard.
- `focus_profiles.py` / `focus_normalize.py` — FocusProfile (split_bias, volume_bias, min_exposure_days) for focused_muscle inputs; `_FINE_TO_COARSE` collapses families (push/pull/legs) to coarse buckets (upper_body/lower_body)
- `day_templates.py` — picks splits, maps archetypes to exercise slots. Dispatches PLUS_CARDIO archetypes to `_push_plus_cardio_slots` / `_pull_plus_cardio_slots` / `_upper_plus_cardio_slots` / `_full_body_plus_cardio_slots` (lift slots + cardio finisher at role="isolation")
- `slots.py` — slot definitions + `density_adjust_slots` (trims low-priority slots to fit `session_minutes`; drop order `warmup → core → isolation → secondary`, primaries never dropped). Cost table keyed per archetype category. Role-based trim means PLUS_CARDIO's cardio finisher (isolation) drops first on SHORT (<=30min) sessions — short lifting sessions silently become pure lifts.
- `planner.py` — orchestrator: slot filling, scoring, exercise selection, injury pattern blocking, dislike filtering. `build_planner_exercise` is the canonical schema helper every code path (planner + AI regenerate + patch rehydration) calls to produce an exercise dict. Houses `generate_recovery_day()`, `generate_mobility_day()`, and `generate_cardio_day()` — the latter accepts `equipment_owned` so Stair Climber / Rowing Machine / Assault Bike are filtered against the user's owned equipment (fixes "stair climber shows up when I don't have one").
- `prescriptions.py` — sets/reps/rest per archetype + slot role. `_prescribe_warmup` always emits a short DYNAMIC warmup (2 sets × 6-8 reps flow, no rest, no static holds) — never long yoga/stretch blocks before heavy lifts. Density trim drops the warmup slot entirely on SHORT sessions.
- `set_programming.py` — intra-workout set scheme, load increments, next-set recommendations
- `in_workout_review.py` — AI-reviewed next-set suggestions (deterministic first, AI only when suspicious)
- `activity_impact.py` — 12-muscle-group fatigue model with decay, negative fatigue for recovery/mobility
- `fitness_score.py` — 4-pillar fitness score (strength 30, cardio 30, consistency 25, recovery 15)
- `cardio.py` — classifies exercises as intervals/steady/easy
- `plan_review.py` / `plan_ai_regenerate.py` — AI plan review is **PERMANENTLY DISABLED** (both workout + nutrition). `PLAN_REVIEW_ENABLED` / `NUTRITION_REVIEW_ENABLED` env flags are no-ops. Deterministic planner ships direct to client.
- `plan_review_v2.py` — **deterministic** weekly plan review (replaces the disabled AI version). Consumes weekly volume + completions + nutrition (DailyNutritionMetrics) + optional Apple Health signals (sleep, RHR, steps, readiness, weight slope) and emits `Recommendation[]` with structured `action` dicts (`reduce_muscle_volume`, `add_cardio_session`, `add_zone2_session`, `swap_to_recovery`, `hold_calorie_adjustment`, `raise_calories`, `lower_calories`, `raise_protein_target`, `raise_fiber_target`, etc.). Builds a deterministic `headline` so the check-in coach can polish without composing from scratch. Exposed via `GET /workouts/weekly-review`.
- `weekly_volume.py` — per-muscle hard-set tracker. Joins `WorkoutSession → WorkoutExercise → ExerciseSet → Exercise.primary_muscle`. Secondary muscles weighted 0.5×; warmups filtered. 5 status tiers per muscle: `undertrained / in_range / high / excessive / spike` (1.5×+ jump from 28-day baseline). 7d / 14d / 28d windows. Exposed via `GET /workouts/weekly-volume`.
- `core_programmer.py` — intentional core placement across the week. Goal × days frequency, category rotation (anti-extension / anti-rotation / lateral / flexion / carry), never-core archetypes (legs / lower / full_body_strength), density gate. Replaces blind `Slot("Core", ...)` inserts.
- `core_planning.py` — older lightweight helpers; superseded by `core_programmer.py` for new plans.
- `ai_first_time_weight.py` — AI starting-weight rec when the layered transfer pipeline finds nothing. Has-history + no-history profile fallbacks. Returns weight only (rounded to 2.5 lb), stamped `weightRecommendationSource = 'ai_first_time'`. Errors fall through to deterministic tier-6/7 defaults.

### Hybrid Cardio Promotion (goal × days × duration)
- `_HYBRID_PAIR` maps every lift-like archetype (push/pull/upper/full_body + heavy/hypertrophy/volume variants + bro-split chest/back/shoulders/arms + strength_maintenance) to its PLUS_CARDIO equivalent. Legs are never mapped (hard lower + cardio = bad).
- `_DIRECT_PROMOTE_COUNT` (`weekly_recipe.py`) specifies hybrids per week by goal × days: muscle_gain 5d→1, 6d→1, 7d→2; strength 5d→1, 6d→1, 7d→1; general_health 3d→1, 4-7d→2. body_recomp/fat_loss use the alternate `_promote_same_day_cardio` path which merges adjacent (lift, cardio) pairs in `_lifting_plus_cardio_recipe`.
- Density trim keeps this safe: PLUS_CARDIO on a SHORT session drops the cardio finisher (role="isolation") before any lift slot, so short workouts stay focused on lifts.

### Weekly Recipe Repair + Rotation
- `PLANNER_VERSION` stamped on every `WorkoutPlan` row. Client `isPlanStale` compares expected version; mismatch triggers silent background regen. Bump on archetype/slot/rep/rest/adjacency rule changes. Format `YYYY.MM.DD.nn`
- `_repair_adjacent_duplicates` — three-tier sweep (Tier A strict safe swap, Tier B net-reducing, Tier C forced triple-break). Runs after interleaving cardio, after recent-focus rotation, and after intensity spacing
- Recent-focus rotation uses fine families (push/pull/legs) when available, coarse buckets otherwise
- U/L forced-even-lift-days rule, PPL forced-multiple-of-3 rule, PPL→UL auto-convert at 4 lift days
- Body_recomp on U/L = 2 heavy + 4 hypertrophy (no longer 4 heavy days)
- 7-day allocation: add cardio, do NOT steal recovery. `_derive_recovery_days` forces 1 recovery day at 7 days regardless of goal
- Mobility/recovery pinned to end of week via last-day-of-week sweep
- Split-identity revert guards — `_preserves_split_identity` after every post-processing pass; if a swap broke split identity the recipe reverts to pre-pass state

### Fatigue System (12 Muscle Groups)
```
chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic
```
- Decay: day 0 = 1.0, day 1 = 0.50, day 2 = 0.25, day 3 = 0.10
- Recovery/mobility days have NEGATIVE fatigue
- Two-pass rolling fatigue: Pass 1 accumulates; Pass 2 applies recovery (max 1 session per day, 15% of current fatigue, capped at 0.15)
- Recovery: -0.08 per muscle, -0.10 systemic; Mobility: -0.05 per muscle, -0.08 systemic
- Fatigue floor clamped at 0.0
- Focus auto-correction on completion via `_infer_focus_from_muscles`
- Graduated planner response: >=60% proceed, 40-60% downgrade, 20-40% swap focus, <20% force recovery
- **Recovery bonus (nutrition-aware)**: `/workouts/fatigue` endpoint returns `nutrition_context` with protein status + coaching message. Thresholds are **% of user's protein target** (not absolute grams): excellent >=95%, good >=80%, low >=60%, very_low <60%. Bonus reduces fatigue on all muscle groups when ratio >=95%; penalty increases it when 60-80%.

### Multiple Completions Per Day
- Workout completion upsert key is `(user, date, focus)` — legs morning + sauna evening = 2 rows, both affect fatigue
- Prevents second activity from overwriting the first

### Recovery/Mobility Day Scaling
- `generate_recovery_day()` and `generate_mobility_day()` scale to `session_minutes` (20–60 min progressive exercise additions)

### Injury System (Three Layers)
1. Movement-pattern blocking — active injuries hard-block dangerous patterns
2. Recovering mode — allows exercises at reduced volume
3. Muscle-group mapping — each injury maps to affected muscle groups for fatigue awareness

Coverage: lower_back, knee, shoulder, hip, hamstring, ankle, achilles, elbow, tennis_elbow, golfer_elbow, wrist, chest, neck. Body part picker (not free text). `InjuryEntry` has: muscleGroups, severity, estimatedRecoveryDays, estimatedRecoveryDate, statusUpdatedAt.

### Plan-View Exercise Swap
- `src/utils/swapScoring.ts` — shared scoring (muscle overlap + compound bucket + movement pattern + equipment class). `rankSwapCandidates(base, library, ownedEquipment, limit)` used by both in-workout and plan-view swap pickers so rankings match.
- Client: "Swap" chip on every `WorkoutCard` exercise row. Tap opens `PlanSwapExerciseModal` (same overlap meter UI as in-workout). Selection mutates `aiWorkoutPlan` in AsyncStorage + local state.
- Library is lazy-fetched via `ensureExerciseLibrary()` on first swap tap so users can swap straight from the plan without opening the Library sub-tab first.

## Nutrition System

### Scoring Architecture (unified, server-authoritative)
One **Nutrition Score** (0-100) composed of three sub-scores:
1. **Adherence** (30-45% weight): calorie alignment + protein alignment. Protein full credit at >=95% of target (relaxed from 100% to avoid false penalties).
2. **Food Quality** (30-40%): 7 inputs — fiber density (14 g/1000 kcal target), added sugar % cals, saturated fat % cals, sodium, minimally-processed %, plant diversity, omega-3 signal
3. **Micronutrient Coverage** (20-30%): priority-6 micros = {calcium, iron, potassium, magnesium, vitamin_d, vitamin_b12}. Vitamin C dropped from priority (trivially hit, tells nothing).

Goal weights (adherence/quality/micro):
- fat_loss 45/35/20, muscle_gain 45/30/25, body_recomp 40/35/25, endurance 40/35/25, general_health 30/40/30, strength 45/30/25.

`SCORE_VERSION=3`, `METRICS_VERSION=3`, `CLASSIFIER_VERSION=3`.

**The longevity_signals_score has been deleted.** Gut & Plants is now a descriptive insight card with facts only (probiotic/fermented/plants/omega-3 — no score).

### Food Classifier (`food_classifier.py` + `ai_classify.py`)
Deterministic + heuristic classifier. Emits per-food flags: `likely_plant_foods`, `plant_count_value`, `fermented_flag`, `probiotic_flag` (strict: live-culture subset), `omega3_flag`, `processing_bucket` (minimally_processed / processed / ultra_processed / unknown), `protein_source` (plant / animal / mixed / none / unknown), plus v3 tags: `seafood_flag`, `fruit_flag`, `vegetable_flag`, `alcohol_flag`, `processed_meat_flag`, `refined_grain_flag`. Fish (salmon/tuna/shrimp/etc.) now resolves as `minimally_processed`.

**v4 — AI amount estimator (`ai_classify.estimate_amounts`)**: runs on **every** food regardless of keyword match (a custom food like "Grandma's chicken soup" no longer falls through). Per-serving estimates for nutrients USDA doesn't carry: `collagen_g_per_serving` (clamped 0–30 g) and `probiotic_cfu_billions_per_serving` (clamped 0–200 B), with `amount_confidence` (high/med/low/none). Cached on `FoodMetadata` keyed by `(normalized_name, classifier_version)` so cost = ~one prompt per unique food forever. **`compute_daily_metrics` always passes `allow_ai=True`** — earlier versions defaulted False which silently zeroed every collagen/CFU estimate. `CLASSIFIER_VERSION` stamped on `FoodMetadata`; bump invalidates cache + triggers re-classification on next meal log.

### Daily Metrics (`gut_health.py`)
Per-day aggregation of per-item tags into `DailyNutritionMetrics` row. Stores: fiber totals, fiber/1000kcal, added sugar, sodium, saturated fat, distinct_plant_foods, fermented/probiotic/omega3/seafood/fruit/vegetable/alcohol/processed_meat/refined_grain servings, plant/animal protein split, processing_counts, max_meal_protein_pct, energy_availability (populated by recovery_flags), recovery_flags JSON.

Runs on every meal-write path — `POST /meals`, `DELETE /meals/{id}`, `POST /meals/log-checked`, and added-meal save via `handleMealSave` (which also auto-checks + logs newly-added meals). Adaptive rolling averages: `get_rolling_averages` divides by `days_with_data` not `window`, so a user with 6 logged days in a 14-day window gets a true 6-day average.

### Fueling & Recovery Flags (`recovery_flags.py`)
Flag-based, never scored. Four flags, tri-state (green/amber/red/not_enough_data):
1. **under_fueling** — 7-day avg energy availability (EA = (intake − exercise kcal) / FFM kg). Red <25 kcal/kg FFM sustained; amber <30; green >=30. FFM from profile weight + sex-default body fat.
2. **low_fat** — 7-day avg fat % of cals. Red <15% sustained; amber <20%; green >=20%.
3. **recovery_nutrients** — magnesium/zinc/vitamin D/selenium adequacy over 7 days. Red if 2+ chronically <50% RDA; amber if 1 chronic or 2+ persistent <70%; green otherwise.
4. **metabolic_support** — cardiometabolic pattern: added sugar >10% cals, sat fat >10% cals, fiber density <8 g/1000kcal, calorie CV >0.30. Red if 3+ concerns sustained; amber if 2; green otherwise.

Optional 5th flag: **thyroid_support** (opt-in only, gated by profile). Never hormone-named in UI. Iodine not scored (USDA coverage too sparse) — educational note only.

### Client Nutrition UI
- **`NutritionCard`** — overview (macros + Nutrition Score + chips + Gut signals strip). Modal drill-down: adherence/quality/micro breakdown bars. Macros removed from modal (redundant with card header).
- **`FuelingRecoveryCard`** — hidden when all flags green. Mounted on HomeScreen → Meals → Plan. Tap opens modal with per-flag detail + "not a medical diagnosis" footer.
- **`IncompleteDayBanner`** — soft nudge when yesterday's logged calories <50% of target. Two actions: "Fill in" (navigates to Foods tab) or "It was right" (dismiss). Dismissal persists per-date in AsyncStorage. Never at login; only on Meals tab.
- **Gut & Plants** — descriptive only. Previously a standalone card, now lives on ProgressScreen Health tab ("Nutrition & Gut Facts") where averaging is adaptive up to 14 days. `GutHealthCard` component was deleted.
- **Score tiles**: probiotic/fermented/plants/omega-3 visible on daily overview without expanding.

### API Surface (nutrition)
- `GET /meals/score?days=7` — authoritative Nutrition Score for today + 7-day weekly. Client reads this for logged meals.
- `GET /meals/gut-health?days=14` — descriptive Gut & Plants facts (today + window). Today payload now includes `collagen_g` and `probiotic_cfu_billions` (AI-estimated amounts).
- `GET /meals/recovery-flags?days=7&thyroid_opt_in=false` — Fueling & Recovery flags.
- `GET /meals/hydration` / `POST /meals/hydration` — daily hydration log + target (half bodyweight in oz by default).
- `GET /meals/averages?window=14` — adaptive rolling averages (divides by days_with_data).
- `GET /meals/insights` — 14-day pattern detection (skipped meals, weekday/weekend diff, food quality distribution).
- `GET /meals/common` — favorites (meals eaten 2+ times in lookback).
- `POST /meals/log-checked` — check-off from plan → persists meal + triggers `_refresh_daily_metrics`.
- `POST /meals/daily-macros` — training-day vs rest-day macro redistribution. Body: base macros + workout context (archetype/focus/cardio_style/stimulus). Returns adjusted macros — calories + protein unchanged, carbs shifted by day type (heavy +25g / leg +15g / hard +10g / standard 0 / easy −10g / rest −25g, capped per goal: fat_loss ±20, muscle_gain ±35, default ±30). Fat absorbs the kcal delta.

### API Surface (workout coaching)
- `GET /workouts/weekly-review?days=7&weight_slope_lbs_per_week=&avg_sleep_hours=&avg_resting_hr=&avg_steps=&readiness_score=` — full deterministic plan review with structured recommendations. Optional query params let the client pass Apple Health-derived signals it already has (no double-fetch).
- `GET /workouts/weekly-volume?days=7` — per-muscle hard-set chart data only (lighter than the full review).

### Nutrition Context for AI Prompts
`meal_history.py` `build_nutrition_context(db, user_id)` pulls rolling averages + common meals; `format_for_prompt` emits them as context lines for the meal skeleton prompt so AI meal plans lean on actual eating patterns.

### Allergen Filter
`allergen_filter.py` runs AFTER AI generation as hard safety net. Scans item names against keyword lists per category (dairy, gluten, tree_nut, peanut, egg, soy, shellfish, fish, sesame) and strips matches. Re-sums meal macros after strip.

### USDA Enrichment
USDA FoodData Central client pulls nutrient #1235 (added sugars) + canonical micros. `food_service.create_food_with_nutrition` persists `added_sugar_g` to `FoodNutrition`. Falls back to AI when USDA returns nothing.

## AI Coach System

Three coaches:

### 1. Home Trainer (unified workout + nutrition)
- **Trigger**: chat input on HomeScreen (`Ask Trainer` / `Ask Coach` buttons).
- **Endpoint**: `POST /ai/trainer-question` → `backend/app/routers/ai/chat.py::ask_trainer_question`.
- **Model**: `MODEL_CHAT` (gpt-4o-mini or gpt-5).
- **Two-phase**: Phase 1 = deterministic intent classification for simple Q&A (fast, no LLM) OR full LLM call. Phase 2 = re-call for structured plan generation when `needs_plan_update=true` and plan wasn't returned.
- **Context passed**: slimProfile (goal, pace, physical stats, days/wk, workout duration, preferredSplit, priorityRegion, equipment, mealRoutine, injuries, experienceLevel) + full workoutPlan + nutritionPlan + scheduleMapping + progress (sessionsLast30d, recentDays, workoutHistory last 6) + foodsAvailable + injuries + last-6 chat turns + optional photo (base64 + MIME) + userContext (last 10 activity-log entries).
- **Response shape**: `{answer, action_items, needs_plan_update, safety_note, updated_goal?, updated_macros?, updated_workout_plan?, updated_nutrition_plan?, updated_injuries?, logged_workouts?, injury_clarification_needed?}`.
- **Persistence**: none on backend. Plan deltas held in `PendingPlanUpdate` client state until user taps Apply.

### 2. In-Workout Coach
- **Trigger**: chat drawer on ActiveWorkoutScreen (Pro-gated).
- **Endpoint**: `POST /ai/workout-question`.
- **Model**: gpt-4o-mini.
- **Context passed** (intentionally narrow): current workout + activeExerciseName + currentSetNumber + loggedSets (weight × reps this exercise).
- **Scope**: form cues, muscle-targeting cues, load/rep adjustment, pain/injury caution, immediate substitutions. Redirects nutrition/lifestyle questions to Home Trainer.
- **Response**: `{answer, quick_cues, adjustment, safety_note}`.
- **Persistence**: none — display-only.

### 3. Check-in Coach (daily/weekly)
- **Trigger**: `CoachCheckinModal` submit.
- **Endpoint**: `POST /coach/checkin` → `backend/app/routers/coach.py::post_checkin`.
- **Model**: gpt-4o-mini via `backend/app/services/coach/checkin_ai.py`.
- **Context passed** (richest of the three): profile + plan targets + 4-7 days of metrics + 7/14/28-day trends + weight summary + active UserFlag rows + last 1-3 AIDecision rows + user feedback dict + (weekly only) history_digest + prior commitments.
- **Response gated** by `decision_rules.gate()` — caps delta size, enforces response-type rules. Response: `{response_type, message, delta, rationale_key, next_commitments}`.
- **Persistence**: `AIDecision` row + `CoachMemory` rows (event_type=ai_checkin and commitment) + optional delta applied to `UserCoachingState.calorie_adjustment`.

### 4. Quick-Action Intent Router (deterministic, no LLM)
- **File**: `backend/app/routers/ai/quick_intents.py`.
- **Wired in**: `routers/ai/chat.py::ask_trainer_question` runs `match_intent(q)` BEFORE the simple-knowledge fast path.
- **12 intents**: `time_limited`, `slept_badly`, `too_sore`, `missed_workout`, `more_cardio`, `less_cardio`, `deload`, `more_core`, `hard_tomorrow`, `losing_too_fast`, `strength_dropping`, `hungrier`.
- **Output shape** matches `TrainerQuestionResponse`. Each handler attaches a structured `action` dict the client can apply to the plan without another AI call (`shorten_workout`, `reduce_intensity`, `swap_to_recovery_or_reduce`, `rebalance_week`, `add_cardio_session`, `reduce_cardio`, `schedule_deload`, `set_core_frequency`, `carb_bump_today`, `raise_calories`, `strength_preservation`).
- Falls through to LLM path on any pattern miss or handler exception.

### Known Context Gaps (recommended for next iteration)
1. Home Trainer has NO readiness / fatigue — user asks "should I do legs today?" and coach is blind.
2. Home Trainer has NO coach memory — every chat starts fresh, can't reference prior advice.
3. Home Trainer has NO weight trend slope / EMA (only check-in coach does).
4. Home Trainer has NO active `UserFlag` rows.
5. Home Trainer has NO Nutrition Score / Recovery Flags / logged-today meals.
6. Home Trainer has NO goal timeline ETA math ("55% timeline elapsed, 40% weight delta achieved").
7. Home Trainer isn't gated by `decision_rules.gate()` — can return dangerous deltas (sub-1000 cal cuts, volume collapse).
8. Home Trainer doesn't persist — no `AIDecision` row written, so trainer can't look back.
9. In-Workout Coach has NO exercise history — "go heavier?" without knowing last session's weight.
10. In-Workout Coach has NO injury context — user reports shoulder injury in Home chat, then bench-presses next day.
11. Meal routine protection (`isRoutine=true`) isn't highlighted to the trainer — routine meals sometimes get swapped.

### Recommended AI Improvements
- Pass `readiness_score`, `top_fatigued_muscles`, `active_flags`, `coach_memory` (last 3 decisions + open commitment), `nutrition_signals` (score + top 2 gaps), `timeline_progress`, and `actual_logged_today` to the Home Trainer context dict. All already computed — just wiring.
- Apply `decision_rules.gate()` to Home Trainer responses for safety caps.
- Persist Home Trainer decisions as `AIDecision` rows on every response that returns an `updated_*` field.
- Move long system prompts out of f-strings and into `backend/app/prompts/*.md` files; load at startup. Enables diffs, A/B, reuse across coaches.
- Build a 10-20 prompt eval harness with expected response types for regression testing on prompt edits.
- Keep two-phase pattern (fast classifier + full LLM). It's the right shape.

## History Plumbing
- `prev_focuses` — raw focus labels from recent completions, surfaced on the single-day generator. Normalized to `recent_focus_buckets` (coarse) + `recent_focus_families` (fine: push/pull/legs) which both feed `generate_weekly_recipe` rotation. Avoids back-to-back same focus.
- History brief includes `user_preferred_split` + `skipped_days_7d` for reviewer context.

## Plan Persistence (DB = source of truth)
- `WorkoutPlan` + `NutritionPlan` tables — one `is_active=True` row per user, stamped with `planner_version` + `created_at`. Every plan generation writes DB first, then mirrors to AsyncStorage.
- Hydration: client loads from DB via `/ai/plan` / `/ai/nutrition-plan`, then hot-caches in AsyncStorage (`aiWorkoutPlan`, `aiNutritionPlans`). On conflict, DB wins.
- Staleness: `isPlanStale` (`planCacheReset.ts`) flags mismatched `planner_version` or plans older than 30d → background regen.
- Cross-device sync: two devices pull latest `WorkoutPlan` row on app-open.

## Scoped Cache Clear (`planCacheReset.ts`)
- `clearWorkoutCache()` / `clearMealCache()` / `clearAllPlanCache()`.
- Substring-matched domain patterns (`workoutDayState_`, `mealPlan_`, `preservedMeal_`, ...).
- `PRESERVED_KEYS` safelist: auth tokens, userProfile, weightEntries, workoutHistory, themePreference, metaData_v1.
- Called by `applyPlanResult` BEFORE writing new plan so workout-only regen doesn't wipe meal state.

## File Structure
```
app/
  _layout.tsx                    # Root Stack
  index.tsx                      # Auth -> Onboarding -> HomeScreen
src/
  screens/                       # Auth, Onboarding, Home, ActiveWorkout, EditProfile, Progress, Supplements
  components/
    NutritionCard.tsx            # Score overview + drill-down modal + Gut signals strip
    FuelingRecoveryCard.tsx      # Flag-based recovery signals; hidden when green
    IncompleteDayBanner.tsx      # Soft yesterday-incomplete nudge (Meals tab only)
    PlanSwapExerciseModal.tsx    # Overlap-ranked exercise swap picker (plan view)
    WorkoutCard.tsx              # Plan day card with per-exercise Swap chip
    RecoveryCard.tsx             # Per-muscle fatigue bars + Overall Load
    NutritionInsightCard.tsx     # Per-nutrient insights (Layer 1+2)
    CoachCheckinModal.tsx        # Daily/weekly check-in input
    ...
  utils/
    nutritionScore.ts            # Client plan-preview score (server authoritative via /meals/score)
    swapScoring.ts               # Shared overlap scoring (in-workout + plan-view)
    layoutAnim.ts                # configureExpandAnimation (spring settle)
    hydration.ts                 # Hydration target math
    ...
  services/api.ts                # All backend API calls
  hooks/useMetaData.ts
backend/
  app/
    main.py                      # FastAPI + startup hooks
    database.py                  # Engine + idempotent migrations (ADD COLUMN IF NOT EXISTS chain)
    models.py                    # SQLModel tables (incl. DailyNutritionMetrics, FoodMetadata with v3 flags, FoodNutrition.added_sugar_g)
    routers/
      auth.py, meals.py, meta.py, profile.py, workouts.py, coach.py
      ai/ (plans, chat, scanning, progression)
    services/
      workout/                   # planner, fatigue, recipes, prescriptions, archetypes, slots, goals, cardio, etc.
      nutrition/                 # nutrition_score, gut_health, score_builder, recovery_flags, food_classifier, meal_history, meal_assembler, calorie_calculator, usda_fdc, allergen_filter
      coach/                     # payload, decision_rules, checkin_ai
    usda_fdc.py                  # USDA FDC client (incl. nutrient #1235 added sugars)
  tests/                         # 18+ modules via run_all.py
```

## UI Layout

### Workout Tab Sub-tabs
- **Plan** — weekly workout plan. Each day card has a swap-capable WorkoutCard.
- **Library** — merged Exercises + Muscles.
- **Settings** — equipment, injuries, preferences.

### Meals Tab Sub-tabs
- **Plan** — daily meal plan. `IncompleteDayBanner` + `FuelingRecoveryCard` mount above the day cards (both conditional).
- **Foods** — search + targets + "YOUR FAVORITES" horizontal scroll of common meals.
- **Supps** — supplements.

### Progress Screen Tabs
- **Health** — Apple Health vitals + Nutrition & Gut Facts (adaptive window up to 14 days) + Muscle Balance (moved here from Body).
- **Body** — per-muscle recovery (RecoveryCard) + weight trend.
- **PRs** — personal records.
- **Charts** — strength + consistency charts.
- Tab transitions: FadeInView keyed on tab + haptic selection on button tap.

### UI Helpers + Conventions
- `shouldHideWeight` / `shouldHideReps` (exerciseDisplay.ts) — single source of truth for bodyweight + stretch exercise display
- Per-exercise muscle chips: `WorkoutCard` reads `primary_muscle` directly. Day-card muscle-chip aggregation is family-filtered to focus. Mobility/recovery days collapse to "Mobility" / "Recovery" label.
- Switch Day picker (allow-with-warnings): every target focus selectable with readiness chip + conflict warning.
- Switch Exercise overlap meter: 0-100% by muscle overlap, >=80% green, >=60% amber, lower red. Logged sets carry over on swap. Same scoring function reused by plan-view swap via `swapScoring.ts`.
- Regen overlays use `ShimmerLogo` for loading state.
- `configureExpandAnimation(300)` spring preset for all card expand/collapse — replaces stock `LayoutAnimation.Presets.easeInEaseOut` which renders imperceptibly fast in iOS release builds.

### Onboarding / Goal Flow
- ACID-style finalize: auth token, username, last user ID, profile writes all deferred to end of flow.
- Pace picker on goal step (conservative / moderate / aggressive) — with haptic selection.
- Target weight required for any weight-change goal (fat_loss / muscle_gain / body_recomp / toning).
- FadeInView keyed on `currentStepKey` for step transitions (220ms).
- Horizontal template scrollers use `decelerationRate="fast"` for snappier flick-and-stop feel.

### Key UI Features
- Exercise dislike excludes from future plans.
- Recovery badge with per-muscle bars; "Overall Load" label.
- Nutrition insight in recovery card when expanded.
- Resume workout modal only if sets logged.
- Rest timer with AI recommendation badge.
- AppState listener catches up timers on foreground return.
- Workout start time persists to AsyncStorage.
- History export: PDF via expo-print.
- Active activities category in LogActivityModal: Yard Work, Chopping Wood, Moving/Lifting, Gardening, House Cleaning, Construction, Shoveling, Playing w/ Kids, Dancing.
- Sports expanded: Pickleball, Surfing, Skiing, Spin Class.

## Dev Commands
```bash
docker compose up -d                                      # Start backend + DB
docker compose build backend && docker compose up -d backend
npx expo start --clear                                    # Frontend
docker compose logs -f backend                            # Backend logs
docker exec thallo-pg psql -U thallo -d thallo            # DB shell
docker exec thallo-backend python -m tests.run_all        # Run all backend tests
docker cp backend/app thallo-backend:/app/ && docker compose restart backend  # Hot-swap for dev
make test                                                 # Alias for run_all
```

## Environment Variables (backend/.env)
```
SECRET_KEY=<change for production>
OPENAI_API_KEY=<your key>
USDA_FDC_API_KEY=<get free key from https://fdc.nal.usda.gov/api-key-signup>
MODEL_CHAT=gpt-4o-mini
MODEL_PLAN_GENERATION=gpt-4o-mini
MODEL_MEAL_PARSING=gpt-4o-mini
PLAN_REVIEW_ENABLED=0           # no-op — AI plan review permanently disabled
NUTRITION_REVIEW_ENABLED=0      # no-op
```

## Database Migrations
SQLModel `create_all` creates tables but doesn't ALTER. Idempotent `ADD COLUMN IF NOT EXISTS` helpers live in `database.py` and run on startup:
- `_ensure_food_category_enum_values`
- `_ensure_food_nutrition_extras_column` — `extra_nutrients` JSONB
- `_ensure_user_recovery_columns` — recovery_question + recovery_answer_hash
- `_ensure_workout_completion_stimulus_column` / `_ensure_workout_completion_health_columns`
- `_ensure_exercise_tracking_mode_column`
- `_ensure_food_metadata_classifier_v2_columns` — protein_source + probiotic_flag
- `_ensure_daily_nutrition_metrics_v2_columns` — plant_protein_g + animal_protein_g + probiotic_servings
- `_ensure_nutrition_v3_columns` — FoodNutrition.added_sugar_g + FoodMetadata seafood/fruit/vegetable/alcohol/processed_meat/refined_grain flags + DailyNutritionMetrics tag servings + recovery_flags JSONB + energy_availability + max_meal_protein_pct
- `_backfill_custom_food_micronutrients` — one-shot backfill on startup

## Apple Watch Integration

### Bidirectional sync via WCSession
- **Bridge**: `modules/thallo-watch-bridge/` (phone) ↔ `targets/thallo-watch/ConnectivityStore.swift` (watch).
- **Outbound (phone → watch)**: `pushWorkoutToWatch`, `pushMealsToWatch`, `pushSupplementsToWatch`, `pushThemeToWatch`, `pushProgressToWatch` (per-set updates), all routed through `applicationContext` with fallback to `transferUserInfo` on duplicate-payload errors.
- **Inbound (watch → phone)**: `start_workout`, `skip_workout`, `cancel_workout`, `end_workout`, `log_set`, `toggle_meal`, `toggle_supplement`, `take_all_supplements`, `pull_state`.
- **Pull-on-wake handshake**: watch fires `pull_state` on `WCSession.activate` + on `sessionReachabilityDidChange(reachable=true)` + on SwiftUI `scenePhase == .active`. Phone responds with a fresh full snapshot. Closes the gap where `applicationContext` queued stale data while the watch app was closed.
- **`isPaired` silent gate REMOVED** from every push — it dropped payloads during transient unpaired states (reboot, session activation). Now only `isAvailable()` (platform support) gates pushes.
- **User-switch wipe**: `clearWatchData()` on sign-out pushes empty workout / meals / supplements payloads so the next signed-in user doesn't see the previous user's stack.

### Watch app pages
- TabView with three pages: **Today** (workout) / **Meals** / **Supps**. Page dots always visible (`.indexViewStyle(.page(backgroundDisplayMode: .always))`). First-launch swipe hint pill auto-dismisses + persists.
- **Active workout**: standalone full set logging via Digital Crown + −/+ steppers, rest timer, HR persistent chip, swipe-right HR zones tab, warm-up card before first set, end + cancel + skip-exercise menu.
- **Phone-side HK write**: completed lift / live-tracker / log-activity sessions write to Apple Health via `saveWorkoutToHealth` (`modules/thallo-healthkit/ios/...::saveWorkout` AsyncFunction wraps `HKWorkoutBuilder`). Watch-started sessions still write via `HKLiveWorkoutBuilder.finishWorkout` from the watch target.

### Watch complication scaffold (#110 — manual Xcode wiring required)
- `targets/thallo-watch-complication/` has a `@bacons/apple-targets` widget config + SwiftUI complication source.
- Surfaces today's focus + readiness on the watch face (accessoryCircular / Rectangular / Inline).
- Reads payload from a SharedDefaults JSON blob (`group.com.thallo.app`) that the main watch app writes on every WCSession update.
- Won't ship until: (a) `expo prebuild` generates the target, (b) App Group entitlement matches across both watch targets, (c) main watch app calls `WidgetCenter.shared.reloadAllTimelines()` after writing the SharedDefaults blob.

### Siri intent scaffold (#111 — manual Xcode wiring required)
- `ios-extras/StartWorkoutAppIntent.swift` is a stub `AppIntent` that opens `thallo://start-workout` via deep link.
- File body is `#if false` until the user adds an Intents extension target in Xcode + matching deep-link handler in `app/_layout.tsx`.

## In-App Dev Logs (#128)
- `src/utils/devLogs.ts` ring-buffers the last 400 `console.log/warn/error/info/debug` entries.
- `src/components/DevLogsViewer.tsx` modal renders them with filter + level + share via iOS share sheet.
- Trigger: Account modal → bottom → "Developer logs" link.
- Critical for TestFlight builds where Metro / Xcode console aren't accessible.

## HealthDataSummary aggregator (#136)
- **File**: `src/services/healthDataSummary.ts`.
- Single source of truth for all Apple Health reads — `getCachedHealthDataSummary()` for instant first paint, `refreshHealthDataSummary()` to force fresh, `getHealthDataSummary({age})` for cached-with-stale-refresh.
- Flat shape: `steps`, `sleepMinutes`, `restingHeartRate`, `hrv`, `workoutMinutes`, `cardioMinutes`, `zone2Minutes`, `activeEnergyKcal`, `weightLbs`, `vo2Max`, plus a `weekly` rollup.
- 30-min stale window, in-flight dedup, null = unknown / 0 = known-zero.
- Z2 fallback: if no HR-zone data, treats steady cardio of 20+ min as Z2 so users without Watch HR still get meaningful counts.
- ProgressScreen migrated to consume it; remaining direct `readHealthSummary` callers can migrate file-by-file (the aggregator wraps the same fn so callers keep working).

## Key Design Decisions
- Workout planner is deterministic — no AI in exercise selection, split logic, or weekly recipe
- AI is gated — meal skeletons, coach chat, food scanning, in-workout set review, food classification AI fallback, first-time weight rec
- Fatigue is 12-muscle-group based, recovery/mobility have NEGATIVE fatigue
- Two-pass fatigue prevents recovery stacking
- Multiple completions per day via `(user, date, focus)` upsert key
- Injuries: pattern blocking + recovering mode + muscle group fatigue
- Day focus changes are deterministic UI buttons, not AI
- Food data: USDA first, AI fallback
- Nutrition scoring is server-authoritative via `/meals/score` for logged meals; client `nutritionScore.ts` only computes for plan-preview
- One Nutrition Score with 3 sub-scores (adherence, quality, micro). Longevity score killed. Food Quality uses 7 explicit inputs, no overlap with Gut & Plants
- Fueling & Recovery Signals are flag-based, tri-state, never hormone-named, hidden when all green
- Meal writes trigger `_refresh_daily_metrics` on POST/DELETE/log-checked and on added-meal save via `handleMealSave`
- Added meals auto-log + auto-check so meal history stays accurate
- Adaptive rolling averages divide by `days_with_data` not `window_days`
- Plan persistence: DB source of truth, AsyncStorage hot cache, `PLANNER_VERSION` mismatch auto-regens
- Cache clear is scoped by domain (workout / meal / all)
- AI plan review (workout + nutrition) is PERMANENTLY DISABLED
- AI first-time weight returns weight only; errors fall through to deterministic defaults
- Exercise swap uses shared `swapScoring.ts` for both in-workout and plan-view
- Hybrid PLUS_CARDIO archetypes emitted by recipe injection AFTER all adjacency repair (PLUS_CARDIO shares focus_family with base lift — adjacency preserved)
- Stair climber / rowing / assault bike filtered by owned equipment (no more phantom stair climbers)
- Warmup prescription is always a short dynamic flow — static stretches only on recovery/mobility days

## Supported Goals
fat_loss, muscle_gain, body_recomp, strength, endurance, athletic_performance, hyrox, toning, maintain, general_health, longevity (UI label "Healthspan"), flexibility, stress_relief. Longevity/healthy_aging/heart_health route to general_health via `_PROFILE_OVERRIDES`. Flexibility/stress_relief have dedicated mobility + recovery profiles.

## Supported Splits
PPL, Upper/Lower, Full Body, PPL+UL hybrid, Bro split (auto-selected based on goal + days).

## AI Apply Path (architectural rule)

**Rule**: AI / weekly-review can only do what the user can do via existing app UI. Recommendations don't directly mutate the active `WorkoutPlan` — they mutate the user-facing settings (UserPreferences, UserCoachingState, UserGoal, UserDayState) that the planner already reacts to on regen. The next regen picks up the changes.

- **Endpoint**: `POST /coach/apply-action` body `{action, rec_key?}`.
- **Implementation**: `backend/app/services/coach/apply_action.py::apply_action`.
- **Supported action types** (mutate durable state):
  - `change_days_per_week` → `UserPreferences.days_per_week` (capped ±1 per apply)
  - `raise_calories` / `lower_calories` → `UserCoachingState.calorie_adjustment` (capped ±250 kcal per apply)
  - `hold_calorie_adjustment` → records explicit user signal in CoachMemory
  - `swap_to_recovery` → tomorrow's `UserDayState.skipped_focus = "recovery"`
  - `noop` → ack only
- **Descriptive-only actions** (record in CoachMemory, no state mutation): `reduce_muscle_volume`, `add_muscle_volume`, `hold_muscle_volume`, `add_cardio_session`, `add_zone2_session`, `reduce_cardio`, `schedule_deload`, `set_core_frequency`, `shorten_workout`, `reduce_intensity`, `carb_bump_today`, `raise_protein_target`, `raise_fiber_target`, `rebalance_week`, `strength_preservation`, `swap_to_recovery_or_reduce`. The next regen factors them via existing volume / focus rotation logic.
- **Wiring**: `WeeklyCoachingCard` (Progress → Health), `CoachCheckinModal` (inline rec pills), trainer chat (`HomeScreen.tsx` quick-intent "Apply" button on assistant messages) all route through this single endpoint.

## actual_rir + Rolling e1RM (P1 from rep/weight audit)

- **Column**: `ExerciseSet.actual_rir DOUBLE PRECISION` (idempotent migration `_ensure_exercise_set_actual_rir_column`). Stored separately from `rpe` because RIR is forward-looking ("how many left in the tank") vs RPE which is perceived exertion.
- **Helper**: `backend/app/services/workout/rolling_e1rm.py::compute_rolling_e1rm(sets, role)`.
- **Math**: `set_e1rm = w * (1 + (reps + actual_rir) / 30)` (Epley with RIR), recency-weighted via `exp(-days_since * ln(2) / 14)` (14-day half-life), then weighted median across the last 6–10 usable sets.
- **Filters**: `completed=True`, not warmup, role-aware rep band (compound 3–10 / isolation 6–15), RIR in [0, 4], weight > 0.
- **Returns** `E1RMEstimate(e1rm_lbs, sample_count, confidence)` with confidence = high / med / low based on n + spread. Returns `None` with <3 usable sets — caller falls back to best-ever 1RM or AI starting weight.
- **Why median not mean**: a single hot session shouldn't lock in a too-high baseline for weeks.

## Watch Active-State Persistence (#148)

- `targets/thallo-watch/ActiveWorkoutView.swift::ActiveWorkoutState` persists `exerciseIndex` / `setNumber` / `restRemaining` / `paused` / `pendingWeight` / `pendingReps` / `lastLoggedWeight` / `lastLoggedReps` to UserDefaults via `didSet` on every `@Published`.
- `hydrate()` runs in `init` so a backgrounded watch app re-mounting picks up exactly where it left off.
- `clearPersisted()` called on workout end/cancel so the next session starts from a clean slate.
- Hydrate guard (`hydrating = true`) prevents the initial restore from looping back through `persist()`.

## Smart Weekly Check-in

`POST /coach/checkin` now ALSO loads `compute_weekly_review` and attaches a trimmed `weekly_review` field to the AI payload (headline, sessions, cardio, zone2, total_hard_sets, muscles_low/high, weight trend, avg protein/fiber, top 5 recommendations). The `SYSTEM_PROMPT` in `checkin_ai.py` is rewritten to require the AI to reference at least one specific number from the review and at least one rec by short name — no more generic "great week!" filler.

The check-in modal (`CoachCheckinModal.tsx`) leads with a "TRAINER'S READ · THIS WEEK" block + inline `Apply` pills on each rec that route through `/coach/apply-action`. The 4-tap rating form stays but is now framed as "confirm/refine the trainer's read" rather than "tell us from scratch."

## Test Suite (#149)

New pure-function tests added to `backend/tests/run_all.py`:
- `tests.test_weekly_volume` — `_classify` band logic, spike detection, range sanity.
- `tests.test_carb_distribution` — protein invariant, carb shifts, per-goal caps, ±5 kcal preservation, 40g floor.
- `tests.test_quick_intents` — all 12 intents match positive cases, no false-positives on generic Q&A, handlers return structured actions.
- `tests.test_rolling_e1rm` — <3 sample fallback, basic Epley+RIR, recency weighting (3 recent vs stale), warmup filtering, role-aware rep band, RIR fallback to target, confidence tier.

Run via `make test` or `docker exec thallo-backend python -m tests.run_all`.

## Recommended Next Improvements

### Performance / observability
- **Backend log structuring**: the `KeyError("Attempt to overwrite 'created'")` from `gut_backfill` startup is pre-existing but pollutes Sentry. Move to `extra={...}` keys that don't collide with `LogRecord` reserved names (`created`, `name`, `levelno`, etc).
- **Per-route latency budgets**: `/workouts/weekly-review` and `/meals/score` are hot paths. Add a simple `time.perf_counter()` log line with route + duration so we can spot regressions.
- **AI cost tracking**: `ai_classify.estimate_amounts` runs once per unique food forever. Add a counter (Prometheus or just a log line) so we can audit "how many AI calls per week per user" — feeds into per-user cost forecasting.
- **DB query budget**: `compute_weekly_volume` runs 4 queries (sessions / exercises / exercise rows / sets). Acceptable for 7-14 day windows but at 28-day windows on a heavy user we should profile + consider an aggregated SQL rollup.

### Tests to add (minimal-effort, high-leverage)
- **Pure-function tests** (no DB): `weekly_volume._classify`, `plan_review_v2._build_headline`, `carb_distribution.classify_day` + `redistribute_macros`, `quick_intents.match_intent` for all 12 patterns. All deterministic.
- **AI estimator regression test**: mock OpenAI client, verify clamping (collagen ≤30g, CFU ≤200B, confidence enum) holds even on out-of-bound responses.
- **Plan review snapshot test**: seed a user with 5 completions over 7 days, no Apple Health, expect specific recommendation keys. Catches future rule-tweak regressions.
- **Watch payload schema**: assert `WatchWorkoutPayload` JSON serialization round-trips through Swift `Codable` decoders. Currently we'd find decode failures only at runtime.

### Future feature wins (queued in audit; not yet shipped)
- **Actual RIR persistence** (`ExerciseSet.actual_rir` column + capture on log → unlocks rolling e1RM, smarter progression, real-effort signal for the trainer).
- **Rolling e1RM** (weighted median over last 6–10 usable sets) → daily rec input; PR display keeps best-ever 1RM.
- **Watch active-state persistence** so backgrounding mid-workout doesn't drop `exerciseIndex` / `setNumber` / `restRemaining`.
- **Watch complication build pass** — finish the SharedDefaults wiring + entitlements so the scaffold actually ships.
- **Siri intent build pass** — add Intents extension target + deep-link router in `app/_layout.tsx` for `thallo://start-workout`.
- **Pre/post-workout time-aware fueling card** — fires when planned workout is in next 2-3h or just finished. Uses meal `consumed_at` + plan time.
- **Functional-pattern archetypes** — explicit `HYBRID_KB_COMPLEX`, `HYBRID_CARRY_FOCUS` for users with kettlebells / sled. Today they fall back to circuit hybrids.

### UI polish
- Migrate remaining direct `readHealthSummary` consumers (HomeScreen, ActiveWorkoutScreen) to `getHealthDataSummary` so HK is queried once per session.
- **Weekly review accept-action wiring**: today the WeeklyCoachingCard's "Apply" button shows a "Got it" alert. Wire each `action.type` to a real plan mutation (e.g. `reduce_muscle_volume` → patch the active WorkoutPlan's relevant slots).
- **Quick-intent action wiring**: same pattern — when the chat returns `action: { type: 'shorten_workout', minutes: 30 }`, auto-apply on user confirm rather than relying on the user to navigate to the Switch Day picker.
