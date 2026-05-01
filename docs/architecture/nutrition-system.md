# Nutrition System — Architecture

Last synced from CLAUDE.md: 2026-04-27

## Scoring Architecture (unified, server-authoritative)

One **Nutrition Score** (0-100) with three sub-scores:
1. **Adherence** (30-45%): calorie alignment + protein alignment. Protein full credit at ≥95% of target.
2. **Food Quality** (30-40%): 7 inputs — fiber density (14 g/1000 kcal target), added sugar % cals, saturated fat % cals, sodium, minimally-processed %, plant diversity, omega-3 signal.
3. **Micronutrient Coverage** (20-30%): priority-6 micros = calcium, iron, potassium, magnesium, vitamin_d, vitamin_b12. Vitamin C dropped (trivially hit).

Goal weights (adherence/quality/micro):
- fat_loss: 45/35/20 | muscle_gain: 45/30/25 | body_recomp: 40/35/25
- endurance: 40/35/25 | general_health: 30/40/30 | strength: 45/30/25

`SCORE_VERSION=3`, `METRICS_VERSION=3`, `CLASSIFIER_VERSION=3`

**The longevity_signals_score has been deleted.** Gut & Plants is descriptive only (no score).

## Food Classifier (`food_classifier.py` + `ai_classify.py`)

Emits per-food flags:
- `likely_plant_foods`, `plant_count_value`
- `fermented_flag`, `probiotic_flag` (strict: live-culture subset only)
- `omega3_flag`
- `processing_bucket`: minimally_processed / processed / ultra_processed / unknown
- `protein_source`: plant / animal / mixed / none / unknown
- v3 tags: `seafood_flag`, `fruit_flag`, `vegetable_flag`, `alcohol_flag`, `processed_meat_flag`, `refined_grain_flag`

Fish (salmon/tuna/shrimp/etc.) resolves as `minimally_processed`.

**v4 AI amount estimator** (`ai_classify.estimate_amounts`): runs on EVERY food regardless of keyword match. Estimates: `collagen_g_per_serving` (clamped 0–30 g), `probiotic_cfu_billions_per_serving` (clamped 0–200 B), `amount_confidence` (high/med/low/none). Cached on `FoodMetadata` keyed by `(normalized_name, classifier_version)`. `compute_daily_metrics` always passes `allow_ai=True`. `CLASSIFIER_VERSION` bump invalidates cache.

## Daily Metrics (`gut_health.py`)

Per-day aggregation → `DailyNutritionMetrics` row. Stores: fiber totals, fiber/1000kcal, added sugar, sodium, saturated fat, distinct_plant_foods, fermented/probiotic/omega3/seafood/fruit/vegetable/alcohol/processed_meat/refined_grain servings, plant/animal protein split, processing_counts, max_meal_protein_pct, energy_availability, recovery_flags JSON.

Runs on every meal-write path: `POST /meals`, `DELETE /meals/{id}`, `POST /meals/log-checked`, and added-meal save via `handleMealSave`.

Rolling averages: `get_rolling_averages` returns both calendar-window averages (`avg_*`, sum divided by the requested window) and logged-day averages (`avg_*_when_logged`, sum divided by days with data). Progress uses logged-day averages when comparing against meal history, and calendar averages when the signal needs to account for unlogged days.

## Fueling & Recovery Flags (`recovery_flags.py`)

Flag-based, never scored. Tri-state: green / amber / red / not_enough_data.

1. **under_fueling** — 7-day avg energy availability (EA = (intake − exercise kcal) / FFM kg). Red <25; amber <30; green ≥30 kcal/kg FFM.
2. **low_fat** — 7-day avg fat % of cals. Red <15%; amber <20%; green ≥20%.
3. **recovery_nutrients** — magnesium/zinc/vitamin D/selenium. Red if 2+ chronically <50% RDA; amber if 1+ or 2+ persistent <70%.
4. **metabolic_support** — added sugar >10%, sat fat >10%, fiber density <8 g/1000kcal, calorie CV >0.30. Red if 3+ sustained; amber if 2.

Optional 5th: **thyroid_support** (opt-in, gated by profile). Never hormone-named. Iodine not scored.

## Client Components

- **`NutritionCard`** — overview (macros + Score + chips + Gut signals). Modal: adherence/quality/micro bars.
- **`FuelingRecoveryCard`** — hidden when all flags green. Shows flag detail + "not a medical diagnosis" footer.
- **`IncompleteDayBanner`** — soft nudge when yesterday logged <50% of target calories. Dismiss persists per-date. Meals tab only.
- **Gut & Plants** — descriptive only. Lives on ProgressScreen Health tab. `GutHealthCard` was deleted.

## API Surface

### Nutrition
| Endpoint | Description |
|---|---|
| `GET /meals/score?days=7` | Authoritative Nutrition Score (today + 7-day). |
| `GET /meals/gut-health?days=14` | Gut & Plants facts. Today includes AI-estimated `collagen_g` + `probiotic_cfu_billions`. |
| `GET /meals/recovery-flags?days=7` | Fueling & Recovery flags. |
| `GET /meals/hydration` / `POST /meals/hydration` | Daily hydration log + target. |
| `GET /meals/averages?window=14` | Adaptive rolling averages (divides by days_with_data). |
| `GET /meals/insights` | 14-day pattern detection. |
| `GET /meals/common` | Favorites (meals eaten 2+ times in lookback). |
| `POST /meals/log-checked` | Check-off from plan → persists meal + triggers `_refresh_daily_metrics`. |
| `POST /meals/daily-macros` | Training-day vs rest-day macro redistribution. Calories + protein unchanged; carbs shifted by day type (heavy +25g / leg +15g / hard +10g / standard 0 / easy −10g / rest −25g). Fat absorbs kcal delta. |

### Workout Coaching
| Endpoint | Description |
|---|---|
| `GET /workouts/weekly-review` | Deterministic plan review with structured recommendations. Optional query params: `weight_slope_lbs_per_week`, `avg_sleep_hours`, `avg_resting_hr`, `avg_steps`, `readiness_score`. |
| `GET /workouts/weekly-volume?days=7` | Per-muscle hard-set data. |

## Nutrition Context for AI Prompts

`meal_history.py::build_nutrition_context(db, user_id)` + `format_for_prompt` emits rolling averages + common meals as context lines for meal skeleton prompt.

## Allergen Filter

`allergen_filter.py` runs AFTER AI generation. Scans item names against keyword lists (dairy, gluten, tree_nut, peanut, egg, soy, shellfish, fish, sesame). Strips matches and re-sums meal macros.

## USDA Enrichment

USDA FoodData Central client pulls nutrient #1235 (added sugars) + canonical micros. `food_service.create_food_with_nutrition` persists `added_sugar_g` to `FoodNutrition`. Falls back to AI when USDA returns nothing.
