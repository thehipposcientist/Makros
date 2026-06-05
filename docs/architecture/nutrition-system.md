# Nutrition System — Architecture

Last synced from app state: 2026-05-25

## Scoring Architecture (unified, server-authoritative)

One **Nutrition Score** (0-100) with three sub-scores:
1. **Adherence** (30-45%): calorie + macro target alignment. Calories are on target within ±5% of the adapted daily target and close within ±10%; protein full credit starts at ≥95%; carbs use a flexible ±15% on-target band; fat is treated as a floor.
2. **Food Quality** (30-40%): 7 inputs — fiber density (14 g/1000 kcal target), added sugar % cals, saturated fat % cals, sodium, minimally-processed %, plant diversity, omega-3 signal.
3. **Micronutrient Coverage** (20-30%): priority-6 micros = calcium, iron, potassium, magnesium, vitamin_d, vitamin_b12. Vitamin C dropped (trivially hit).

Source: `/meals/score` scores logged `MealItem` rows first. When no logged meal items exist for the day, it falls back to the projected day plan from `UserDayState.nutrition_plan` / `PlanDay.nutrition_json`.

Goal weights (adherence/quality/micro):
- fat_loss: 45/35/20 | muscle_gain: 45/30/25 | body_recomp: 40/35/25
- endurance: 40/35/25 | general_health: 30/40/30 | strength: 45/30/25

`SCORE_VERSION=7`, `METRICS_VERSION=5`, `CLASSIFIER_VERSION=7`

**The longevity_signals_score has been deleted.** Gut & Plants is descriptive only (no score).

## Food Classifier (`food_classifier.py` + `ai_classify.py`)

**v7 — AI-authoritative, no substring matching.** Classification is never derived from keyword/substring matching of a food name. `food_classifier.py` holds only the shared dataclass, the `normalize_name` cache-key builder, and the plant-slug → category reference map. All classification runs through `ai_classify.get_or_create_metadata`.

Order of authority for the processing bucket:
1. An external NOVA grade when one exists — OpenFoodFacts' `nova_group` on the barcode path (`processing_bucket_override`).
2. `ai_classify.ai_classify_food` — one AI call, NOVA-graded, that also emits every food-quality flag.

Emits per-food (all AI-resolved):
- `processing_bucket`: minimally_processed / processed / ultra_processed
- `likely_plant_foods`, `plant_count_value` (composites get an estimated diversity count)
- `fermented_flag`, `probiotic_flag` (live-culture subset)
- `omega3_flag`, `omega3_source`
- `protein_source`: plant / animal / mixed / none
- `seafood_flag`, `fruit_flag`, `vegetable_flag`, `alcohol_flag`, `processed_meat_flag`, `refined_grain_flag`

**Zero unknowns.** `get_or_create_metadata` never persists `processing_bucket="unknown"` for a real food. A cold miss it could not AI-classify (no key / API down) is stored as a conservative `"processed"` default with `source="defaulted"` and re-graded the next time AI is available. Sources: `ai`, `external` (NOVA), `defaulted`.

**Cache only for historical data.** Results are cached on `FoodMetadata` keyed by `(normalized_name, CLASSIFIER_VERSION)`. Live request paths classify cold-miss foods as they are created or logged, then reuse the cache. Existing current-version AI rows are not re-enriched from normal reads, and startup/deploy no longer has a food-classification backfill hook. `lookup_classification` is the read-only cache lookup used by hot search-result paths (never triggers AI).

The amount estimator (`ai_classify.estimate_amounts`) runs only during live cold-miss classifications. Estimates: `collagen_g_per_serving` (clamped 0–30 g), `probiotic_cfu_billions_per_serving` (clamped 0–200 B), `prebiotic_g_per_serving` (clamped 0–25 g), `amount_confidence` (high/med/low/none).

## Daily Metrics (`gut_health.py`)

Per-day aggregation → `DailyNutritionMetrics` row. Stores: fiber totals, fiber/1000kcal, added sugar, sodium, saturated fat, distinct_plant_foods, fermented/probiotic/omega3/seafood/fruit/vegetable/alcohol/processed_meat/refined_grain servings, plant/animal protein split, processing_counts, max_meal_protein_pct, energy_availability, recovery_flags JSON.

Health Insights treat red/processed meat as amount-aware, not just binary frequency: fresh red meat is normalized to cooked 3 oz / 85 g serving-equivalents and compared against the 12-18 oz/week evidence window; processed meat is normalized to 50 g equivalents, with repeat-day frequency used only as supporting context.

Health Insight confidence must stay tied to signal quality. Food-name tags, potassium/calcium/omega-3 proxies, digestion exposure hints, calorie-target fueling proxies, and behavior-only bone/hormone/energy context can support a hypothesis, but they must cap or explain confidence instead of sounding clinical.

Hormone + Cellular Signals live under `GET /health/metabolic-signals` rather than `/meals/*` because nutrition is only one input. The service can use meal completeness, macros, energy availability, fat intake, micronutrient proxies, meal timing, sleep, wearable vitals, training load, demographics, and optional labs. The UI should frame the result as lifestyle support / opportunity, never as measured hormone production. Stress/cortisol rhythm is shown by daypart because a normal pattern has higher wake/morning cortisol and lower evening cortisol; Thallo estimates support and strain around that rhythm, not actual cortisol output.

Protein Health Insight output is consolidated under `protein_quality_pattern`: the card combines per-lb protein adequacy, plant/animal source mix, source diversity, largest-meal concentration, high-carb/low-protein meal flags, and post-workout timing instead of publishing a separate protein-distribution card.

Brain Health Insight output lives under `brain_health_support`: it is a non-diagnostic support card using sleep duration/timing, omega-3 or seafood patterns, fiber/plant variety, hydration, activity/cardio, caffeine/alcohol timing, optional micronutrient logs, and optional HRV/RHR context. It must stay framed as cognitive-energy and brain-health habit support, not a cognitive test or neurological-risk prediction.

Runs on every meal-write path: `POST /meals`, `DELETE /meals/{id}`, `POST /meals/log-checked`, and added-meal save via `handleMealSave`.

Rolling averages: `get_rolling_averages` returns both calendar-window averages (`avg_*`, sum divided by the requested window) and logged-day averages (`avg_*_when_logged`, sum divided by days with data). Progress uses logged-day averages when comparing against meal history, and calendar averages when the signal needs to account for unlogged days.

Nutrition day completeness is explicit. `UserDayState.nutrition_log_status` can be `unknown`, `partial`, `rough_estimate`, or `complete`; inferred completeness is returned on `/meals/score`, snapshotted into `DailyRollup`, and used to keep sparse logs from driving recovery/readiness/coaching claims as full-day intake. Only `rough_estimate` and `complete` are usable for recovery analytics.

## Fueling & Recovery Flags (`recovery_flags.py`)

Flag-based, never scored. Tri-state: green / amber / red / not_enough_data.

1. **under_fueling** — 7-day avg energy availability (EA = (intake − exercise kcal) / FFM kg). Red <25; amber <30; green ≥30 kcal/kg FFM.
2. **low_fat** — 7-day avg fat % of cals. Red <15%; amber <20%; green ≥20%.
3. **recovery_nutrients** — magnesium/zinc/vitamin D/selenium. Red if 2+ chronically <50% RDA; amber if 1+ or 2+ persistent <70%.
4. **metabolic_support** — added sugar >10%, sat fat >10%, fiber density <8 g/1000kcal, calorie CV >0.30. Red if 3+ sustained; amber if 2.

Optional 5th: **thyroid_support** (opt-in, gated by profile). Never hormone-named. Iodine not scored.

Exercise kcal source: imported/wearable calories win. If a manual/custom activity arrives without calories, `/workouts/complete` stores a conservative MET-based estimate from activity type, duration, intensity, and bodyweight so same-day targets and energy availability still react. When Apple Health has recent full days with both basal and active energy, maintenance is anchored to `basal + active` total burn rather than multiplying basal by the generic activity multiplier. Basal-only data still calibrates formula BMR with a bounded adjustment. The live `/meals/adjusted-daily-target` treats normal planned workouts as already covered by base TDEE, and only adds calories for extra workouts, planned-workout excess beyond the expected allowance, or same-day NEAT above the HealthKit baseline. UI labels show the resulting exact daily target; ±5%/±10% bands are adherence zones, not the headline goal.

Hydration target ranges wrap the fully adapted water midpoint. The backend still computes `target_oz` from body size, sex/age, planned or completed training, active energy, heat when available, logged protein, and alcohol; `/meals/hydration` additionally returns `target_ounces_min` / `target_ounces_max`, and reminders treat the lower bound as "met."

## Client Components

- **`NutritionCard`** — overview (macros + Score + chips + Gut signals). Modal: adherence/quality/micro bars.
- **`FuelingRecoveryCard`** — hidden when all flags green. Shows flag detail + "not a medical diagnosis" footer.
- **`IncompleteDayBanner`** — soft nudge when yesterday logged <50% of target calories. Dismiss persists per-date. Meals tab only.
- **Gut & Plants** — descriptive only. Lives on ProgressScreen Health tab. `GutHealthCard` was deleted.
- **Hydration** — Today card panel + Apple Watch quick-add. Daily log is persisted server-side through `UserDayState.nutrition_plan._hydration_oz`, mirrored into local cache for optimistic/offline rendering, and retried when needed.
- **Hydration reminders** — local `expo-notifications` schedule from Settings. Uses a daytime window + cadence, respects quiet hours, and suppresses remaining same-day slots once the lower end of the logged hydration range is met.

## API Surface

### Nutrition
| Endpoint | Description |
|---|---|
| `GET /meals/score?days=7` | Authoritative logged-first Nutrition Score (today + 7-day; projected fallback for unlogged days). |
| `GET /meals/gut-health?days=14` | Gut & Plants facts. Window includes serving totals plus daily averages for fermented/probiotic/omega-3; omega-3 includes logged EPA/DHA supplements. Today includes AI-estimated `collagen_g` + `probiotic_cfu_billions`. |
| `GET /meals/recovery-flags?days=7` | Fueling & Recovery flags. |
| `GET /meals/hydration` / `POST /meals/hydration` | Daily hydration log + target. Target uses body size/sex/age, planned or completed exercise, activity metadata, workout calories/HealthKit active energy, logged protein, and alcohol. Sodium/electrolytes/creatine/caffeine are returned as guidance signals; they do not silently raise ounces. The response includes `breakdown.heat`, but it is currently zero because no weather/ambient-temperature source is wired into this endpoint yet. |
| `GET /meals/averages?window=14` | Adaptive rolling averages (divides by days_with_data). |
| `GET /meals/insights` | 14-day pattern detection. |
| `GET /meals/common` | Favorites (meals eaten 2+ times in lookback). |
| `POST /meals/log-checked` | Check-off from plan → persists meal + triggers `_refresh_daily_metrics`. |
| `POST /meals/daily-macros` | Training-day vs rest-day macro redistribution. Calories + protein unchanged; carbs shifted by day type (heavy +25g / leg +15g / hard +10g / standard 0 / easy −10g / rest −25g). Fat absorbs kcal delta. |

## Hydration Weather / Location Status

Current location use is workout-scoped, not nutrition-scoped: phone and Watch GPS are used for outdoor cardio distance, pace, and route capture. Hydration does not currently request or store location.

Recommendation: add an optional coarse weather layer for hydration and recovery. The user-facing setting should ask to "Use local weather to adjust hydration and recovery targets" and accept city/ZIP, manual climate presets, or OS approximate location. Store weather observations (`temp_f`, `humidity_pct`, `heat_index_f`, `altitude_m`, `observed_at`, source), not raw background coordinates. Use those observations to pass `ambient_temp_f` into `compute_hydration_target_oz`, adjust electrolyte guidance on hot/humid outdoor-cardio days, and add high-altitude/dry-climate copy. Do not expose location/weather data through social features, and do not send precise coordinates to AI prompts.

### Workout Coaching
| Endpoint | Description |
|---|---|
| `GET /workouts/weekly-review` | Deterministic plan review with structured recommendations. Optional query params: `weight_slope_lbs_per_week`, `avg_sleep_hours`, `avg_resting_hr`, `avg_steps`, `readiness_score`. |
| `GET /workouts/weekly-volume?days=7` | Per-muscle hard-set data. |

## Nutrition Context for AI Prompts

`meal_history.py::build_nutrition_context(db, user_id)` + `format_for_prompt` emits rolling averages + common meals as context lines for meal skeleton prompt.

## Allergen Filter

`allergen_filter.py` runs AFTER AI generation. Scans item names against keyword lists (dairy, gluten, tree_nut, peanut, egg, soy, shellfish, fish, sesame). Strips matches and re-sums meal macros.

## Remote Food Providers

USDA FoodData Central client pulls nutrient #1235 (added sugars) + canonical micros. Search is read-through: random USDA results are not persisted just because they appeared in search. The user's kitchen (`UserPreferences.foods_available` plus synced `customFoods`) is treated as local Thallo search data and suppresses remote provider lookups for matching queries. When a user selects a USDA result and saves/logs the meal, the item carries its `fdc_id` through the client and `food_service.upsert_catalog_food_from_search_item` imports it as a verified global `Food`/`FoodNutrition`/`FoodServing` row, then the meal logging path marks it in `UserRecentFood` for that user. AI fallback search results follow the same selection-only rule but are stored as private, unverified `source=ai` foods owned by that user, never as shared catalog rows. Future searches should hit Thallo local/recent/kitchen rows before calling remote FatSecret/USDA/AI. Meal plan generation merges user custom-food names into the generation pantry and hydrates private custom foods with the current user scope. Falls back to AI when verified providers return nothing.

FatSecret search is a read-through restaurant/branded provider inserted before USDA when credentials are configured (`FATSECRET_CLIENT_ID`, `FATSECRET_CLIENT_SECRET`). `FATSECRET_SEARCH_VERSION=v1` works with the basic search shape; `v5` is for Premier/Premier Free access and returns richer serving nutrition. FatSecret rows are returned to the picker as `source=fatsecret` but are not imported into the shared or private `foods` catalog because FatSecret's storable-data rules only mark `food_id` and `serving_id` as indefinitely storable. If a user logs one, the meal item keeps the user-facing nutrition snapshot while future searches should re-query FatSecret.

Barcode lookup checks the user's private/local catalog first, then USDA Branded search, then OpenFoodFacts as a user-scoped fallback. OpenFoodFacts-derived rows are imported only as private `source=barcode` foods when selected/logged so crowdsourced/licensed label data does not enter the shared catalog. User-submitted foods go through `POST /foods/submissions`: the user immediately gets a private `source=user` food row for reuse, while a `FoodSubmission(status=pending)` row preserves label/barcode/photo metadata for later review before any global promotion.
