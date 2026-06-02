"""
Tiny test runner — invokes every `test_*` module under `tests/` and
aggregates their pass/fail counts.

Each test module is expected to:
  - expose a `cases = [...]` list of test functions, OR
  - guard its own `__main__` block that runs cases and exits with
    a non-zero code on failure
We use the second contract because every test module already ships
that pattern. We just import and run their `__main__` equivalent.

Run:
    docker exec thallo-backend python -m tests.run_all
"""
from __future__ import annotations

import importlib
import os
import sys
import traceback

if os.getenv("ALLOW_LIVE_OPENAI_TESTS") != "1":
    os.environ.pop("OPENAI_API_KEY", None)
    os.environ["OPENAI_DISABLED_FOR_TESTS"] = "1"


_TEST_MODULES = (
    "tests.test_calorie_calculator",
    "tests.test_goal_params_invariants",
    "tests.test_meal_assembler",
    # AI-free skeleton generator — replaces call_skeleton_ai by default.
    "tests.test_deterministic_skeleton",
    "tests.test_workout_planner",
    "tests.test_workout_goals",
    "tests.test_goal_matcher",
    "tests.test_workout_archetypes",
    "tests.test_focus_differentiation",
    "tests.test_set_programming",
    "tests.test_in_workout_review",
    "tests.test_fitness_score",
    # Planner canonical-schema + focus wiring + patch rehydration.
    "tests.test_planner_schema",
    # prev_focuses → planner rotation + meal_history → nutrition context.
    "tests.test_history_plumbing",
    # Fatigue overlay + AI first-time starting-weight branch.
    "tests.test_recommendation_fatigue_and_ai",
    # Planner-integrity regression tests (UL priority, heavy PPL
    # prescription, non-destructive validate_plan, split identity).
    "tests.test_planner_integrity_fixes",
    # First-class WorkoutPlan persistence: active-row bookkeeping on
    # regen, PLANNER_VERSION stamping, active-plan endpoint.
    "tests.test_workout_plan_persistence",
    # First-class NutritionPlan persistence: mirror of WorkoutPlan —
    # active-row bookkeeping, JSON round-trip, active-plan endpoint.
    "tests.test_nutrition_plan_persistence",
    # Meal-logging refactor: favorites/routines (templates) vs daily logs
    # (instances) — edit isolation, idempotent logging, occurrence dedupe.
    "tests.test_meal_logging_isolation",
    "tests.test_meal_page_contract",
    "tests.test_saved_meal_sharing",
    "tests.test_food_image_provider",
    # Backend meal stabilization matrix: idempotency, routine occurrence
    # identity + exceptions, favorite/copy/split provenance, delete semantics
    # by source_type, backlog timestamps, food-ownership isolation.
    "tests.test_meal_stabilization",
    # Favorite/unfavorite day-state sync + future-day dedup backfill.
    "tests.test_meal_favorite_sync",
    # PR detection: heaviest_weight / estimated_1rm / volume_record
    # emitted from /workouts/complete after set rows are written.
    "tests.test_pr_detection",
    # Weekly digest: 7-day review with sessions/volume/PRs/nutrition.
    "tests.test_weekly_digest",
    # Pure-function tests for the new deterministic services.
    "tests.test_weekly_volume",
    "tests.test_goal_forecast",
    "tests.test_goal_scoring",
    "tests.test_carb_distribution",
    # Data imports — pure-function parsers (no DB / network).
    "tests.test_imports_mfp_parser",
    "tests.test_imports_mfp_matcher",
    "tests.test_imports_strong_parser",
    "tests.test_imports_fitnotes_parser",
    "tests.test_imports_strava_mapper",
    "tests.test_emphasis_inference",
    "tests.test_exercise_video_search",
    "tests.test_quick_intents",
    "tests.test_rolling_e1rm",
    # Bulk e1RM endpoint — single source of truth for displayed 1RM
    # across the Progress screen (chart, showcase, PR cards).
    "tests.test_e1rm_bulk",
    # One-rep-max showcase rolling overlay — pure function that
    # makes the showcase tile, the chart, and the PR cards agree.
    "tests.test_one_rep_max_showcase",
    # Fatigue-aware Fresh Strength Signal — late-session squats no
    # longer inflate the strength score. Pure helper tests.
    "tests.test_strength_signal",
    # Per-muscle hypertrophy / improvement score — orthogonal to
    # Fresh Strength so muscle gains show up even when 1RM is flat.
    "tests.test_muscle_progress",
    # Hydration atomic delta — guards against the lost-increments bug
    # where rapid quick-add taps overwrote each other on the server.
    "tests.test_hydration_delta",
    # Pure-function tests for the adaptive hydration target service.
    "tests.test_hydration_target",
    "tests.test_live_workout_recommendations",
    "tests.test_social_digest",
    "tests.test_social_notifications",
    "tests.test_social_perf_and_privacy",
    "tests.test_trainers",
    "tests.test_cycling_power",
    # Cardio prescription — modality detection, capability hierarchy, prescription_type tagging.
    "tests.test_cardio_prescription",
    # HR-zone math + parity contract with the frontend canonical module.
    "tests.test_hr_zones",
    # Passive sun exposure estimates — coefficients, confidence, safety copy, privacy storage.
    "tests.test_sun_exposure",
    # Context-aware health insights — opt-in, confidence, safety, privacy, and next action.
    "tests.test_context_insights",
    # Optional lifestyle factors — private daily context for recovery/nutrition interpretation.
    "tests.test_lifestyle_factors",
    # Weekly calorie budget smoothing — formula, caps, macro redistribution.
    "tests.test_weekly_calorie_budget",
    # DB-aware nutrition target resolver — coach deltas, Apple Health signals,
    # recent weight, and per-day macro redistribution.
    "tests.test_adaptive_nutrition_targets",
    "tests.test_plan_week",
    # Mid-week regeneration: done-day protection + split/dpw/equipment changes.
    "tests.test_plan_week_midweek_regen",
    # Goal change: no PlanWeek/PlanDay mutation, snapshot fields, review override.
    "tests.test_plan_week_goal_change",
    # Auth: DEV_EMAIL_TOKENS gating — dev tokens must not leak in prod.
    "tests.test_auth_dev_token_isolation",
    # Auth: users can change their globally unique social handle.
    "tests.test_auth_username",
    # Auth: unfinished email signups can be safely restarted.
    "tests.test_auth_register",
    # Auth/legal: per-version acceptance is stamped and auditable.
    "tests.test_auth_legal",
    # Account deletion: sensitive rows are removed and login identifiers anonymized.
    "tests.test_account_deletion",
    # Entitlements: unknown users fail closed; beta signups default to Pro.
    "tests.test_entitlements",
    # Billing: RevenueCat events and server-authoritative trial/paid access.
    "tests.test_billing",
    # Supplement metadata helpers: source-term inference + curated
    # detail-metadata lookup.
    "tests.test_supplement_enrichment",
    # Supplement usage guidance: cycling/short-term advice and
    # history-aware triggers.
    "tests.test_supplement_usage",
    # CORS: prod must fail closed instead of wildcard+credentials.
    "tests.test_cors_config",
    # Field encryption: opaque client state stores encrypted-at-rest JSON and
    # legacy plaintext rows remain readable during migration.
    "tests.test_field_encryption",
    # Native account sign-in: Apple identity links and account creation.
    "tests.test_auth_apple",
    # Native account sign-in: Google identity links and account creation.
    "tests.test_auth_google",
    # Startup gates: schema startup remains light; data jobs explicit.
    "tests.test_startup_maintenance",
    # PlanWeekCheckin: status, gate, idempotency, skip, recap.
    "tests.test_plan_week_checkin",
    # Workout start marker: in-progress session, never phantom completion.
    "tests.test_workout_start",
    # Workout completion retry/double-tap idempotency.
    "tests.test_workout_completion_idempotency",
    # plan_cadence_anchor: pure helper that locks the user's sign-up
    # day-of-week as the rhythm for every future plan-week start_date.
    "tests.test_plan_cadence_anchor",
    # Plan generation respects the user's session_minutes budget — fills
    # close to the target without going far under (the underfill bug
    # density_adjust_slots was extended to fix).
    "tests.test_plan_time_budget",
    # Change Day Type — conflict detection + smart adjust reconciliation.
    "tests.test_change_day_type",
    # Switch Day pin/rotate/swap algorithm — pure-function helper.
    "tests.test_switch_day",
    # Switch-day rotation + split-anchor: prefer_swap, pin injection, history scenarios.
    "tests.test_switch_day_rotation",
    # Cross-split preservation: all splits × regen/switch/7th-day with realistic histories.
    "tests.test_split_preservation",
    # Split-cycle integration: full generate_weekly_recipe pipeline (anchor →
    # avoid-recent → fatigue → repair → identity guards) × split × goal × history.
    "tests.test_split_cycle_integration",
    # Completed-today overlay: full-regen day-0 pinning, +Cardio normalization,
    # client overlay simulation across all splits × goals × day counts.
    "tests.test_completed_today_overlay",
    # User-scenario regression: each test encodes a real user-reported bug
    # with full history → generate → client overlay → assert correct plan.
    "tests.test_user_scenario_regression",
    # Switch Day per-split comprehensive — ~20 tests × 5 splits + edge cases.
    "tests.test_switch_day_splits",
    # Switch Day INTEGRATION — pin every position × every focus on
    # real recipes from the planner. Asserts the result week still
    # satisfies the split contract.
    "tests.test_switch_day_integration",
    # Generation matrix — split × goal × days/week assertions on
    # fresh-week recipes (bro canonical, cardio alignment, no
    # PLUS_CARDIO downgrade on bro, recovery placement, etc.).
    "tests.test_generation_matrix",
    # Single-day regen pieces — focus normalization, recent_focus
    # rotation, focus_override matching.
    "tests.test_single_day_regen",
    # Router-level history-merge behavior + single-day preservation
    # invariants (pin_focus prepend, prev_focuses prepend + reverse,
    # split shape preserved across day_index calls).
    "tests.test_history_aware_generation",
    # End-to-end /workouts/generate-week with current_days (pin-against-
    # current-week single-day swap behavior).
    "tests.test_generate_week_endpoint",
    # HTTP injury integration: /workouts/generate-week and /plans/start-new-week
    # response + persisted plan rows honor injury movement blocks.
    "tests.test_injury_http_integration",
    # Severity-aware structured-injury path (planner consumption,
    # severity → blocked patterns, fatigue boost magnitudes, conflict
    # detector). Pure-function — no DB.
    "tests.test_injury_structured",
    # Coach guardrail: AI cannot silently save an injury — user must
    # affirmatively confirm before updated_injuries is honored.
    "tests.test_injury_confirmation_guard",
    # Coach apply-action: every action type, every safety cap, every
    # mutation path on UserPreferences/UserCoachingState/UserDayState.
    "tests.test_apply_action",
    # Decision-rules gate: data sufficiency, cooldowns, kcal clamping,
    # flag-severity gating for AI suggestions.
    "tests.test_decision_rules",
    # Recovery flags: tri-state computations + the metabolic_support
    # bug-fix (zero-cal placeholder rows now correctly return
    # not_enough_data, not green).
    "tests.test_recovery_flags",
    "tests.test_metabolic_signals",
    # Nutrition completeness: partial logs stay visible but do not drive
    # complete-day recovery / coach claims.
    "tests.test_nutrition_day_completeness",
    # Deterministic weekly review: scenario-driven recommendations.
    "tests.test_plan_review_v2",
    # Food classifier: per-food tagging (probiotic, omega3, processing
    # bucket, protein source, v3 flags).
    "tests.test_food_classifier",
    # Food catalog search: local/recent/USDA/AI merge contract + recent
    # tracking for search-selected food IDs.
    "tests.test_food_search",
    # Food photo scan context: user-described oils/sauces that are not
    # visually obvious still get included as conservative add-ons.
    "tests.test_food_scan_context",
    # MyFitnessPal import pipeline: nutrient snapshots, USDA normalization,
    # idempotent first-class Meal/MealItem writes.
    "tests.test_imports_mfp_pipeline",
    # Strong import pipeline: duplicate Strong set-order markers and
    # warmups become first-class ExerciseSet rows without constraint errors.
    "tests.test_imports_strong_pipeline",
    # FitNotes import pipeline: date-grouped CSV rows become first-class
    # workout sessions with converted units and idempotent re-uploads.
    "tests.test_imports_fitnotes_pipeline",
    # Allergen filter safety net: plural matching + macro re-sum
    # (real bugs found and fixed).
    "tests.test_allergen_filter",
    # Logged meal copy/split: cloned rows scale quantity, macros, and
    # micronutrient snapshots while refreshing normal meal metrics.
    "tests.test_meal_copy_split",
    # Meal-log dedup: editing a meal (incl. its time) updates in place across
    # sources instead of appending a duplicate. Regression for the edit-time bug.
    "tests.test_meal_log_dedup",
    # Plateau detection: 4-week flat 1RM → suggestion.
    "tests.test_plateau_detection",
    # Streak + compliance coaching.
    "tests.test_streak",
    # Server-side readiness compute — pillar isolation, reweighting,
    # determinism, computed_at_ms versioning. The whole reason this
    # exists: phone+watch readiness can't drift when only the server
    # computes the score.
    "tests.test_readiness_compute",
    # Readiness focus/muscle surface — per-focus + per-muscle readiness and the
    # avoid-heavy-lower recommendation flow through to the card; daily soreness /
    # joint-pain check-in caps the right muscles (heavy-PR-leg-day scenario).
    "tests.test_readiness_focus_surface",
    # Weekly recipe unit tests — pure-function coverage of lifting_recipe,
    # inject_hybrid_cardio, repair_adjacent_duplicates, predicates.
    "tests.test_weekly_recipe_unit",
    # Weekly recipe planned-session snapshots and summary invariants.
    "tests.test_weekly_recipe_snapshots",
    # Weekly nutrition review + feedback loop (planned vs actual, recs, apply_action).
    "tests.test_nutrition_review",
    # Density trimming + prescription dispatch + core programmer.
    "tests.test_density_and_prescriptions",
    # Exercise seed/import equipment contracts — planner and swaps both
    # depend on canonical equipment slugs.
    "tests.test_exercise_seed_equipment",
    # Seed-to-consumer integration — reference rows are idempotently
    # inserted into a real DB and consumed by meta/hydration services.
    "tests.test_seed_integration",
    # E2E seed personas — deterministic returning-user fixtures for
    # Maestro/API smoke coverage.
    "tests.test_e2e_seed",
    # Session-duration slot injection — bonus isolations at 75/90 min,
    # PLUS_CARDIO/non-lift exclusions, density interaction, integration.
    "tests.test_session_duration_slots",
    # Phase 1 perf bundle — meal-refresh debounce, rollup window batching,
    # readiness TTL cache + invalidation hooks.
    "tests.test_phase1_perf",
    # Phase 2 — three new health-signal flags (HRV trend, respiratory
    # rate elevated, HRV erratic / chronic stress).
    "tests.test_phase2_flags",
    # Phase 3 — cycle-aware readiness pillar + weight EMA on weekly
    # review. Hourly readiness refresh is mostly client-side and
    # covered by Phase 1's cache + invalidation tests.
    "tests.test_phase3_readiness",
    # Phase 4 — body comp + BP fields on WeeklyCheckIn, plus the new
    # RecoveryActivity model + router (cold plunge, sauna, breathwork,
    # meditation logging).
    "tests.test_phase4_tracking",
    # Profile weight source of truth — measurement-only check-ins must
    # not promote cached/history weights into UserProfile.weight_lbs.
    "tests.test_profile_weight_sync",
    # Goal/equipment compatibility warnings — planner may fall back, but
    # the app must be honest about mismatched goals and gear.
    "tests.test_goal_equipment_guardrails",
    # Health persistence: batch sleep + daily HealthKit snapshots keep
    # partial-field upsert semantics for login/device restores.
    "tests.test_health_sleep_persistence",
    # Sleep pressure: rolling, capped sleep shortfall signal for
    # readiness context without treating sleep as a literal debt ledger.
    "tests.test_sleep_pressure",
    # Optional lab marker persistence + lab-report scan candidate cleanup.
    "tests.test_health_labs",
    # Insight Engine: deterministic wellness pattern cards, missing-data
    # confidence behavior, and medical-safety language guardrails.
    "tests.test_insight_engine",
    # Coach chat: photo attachments + multi-turn conversation history
    # (the active-workout coach can now see a snapped photo and answer
    # follow-up questions without re-stating context).
    "tests.test_coach_chat_photos",
    # Coach chat guardrails: AI may propose settings/injuries, but never
    # return replacement workout/nutrition plans.
    "tests.test_coach_chat_guardrails",
    # AI governance: identity redaction, usage metadata, throttles, and
    # deterministic prompt-output evals for Home Trainer setting proposals.
    "tests.test_ai_governance",
    # Gear tracker: photo identification should use the shared vision-model
    # selector and multipart image payloads.
    "tests.test_gear_tracking",
    # Social: privacy fix (soft-deleted users hidden) + digest perf
    # (batched queries instead of per-friend N+1).
    "tests.test_social_perf_and_privacy",
    # Nutrition score pipeline + allergen filter edge cases + solver.
    "tests.test_nutrition_score_unit",
    # Plan generation integration — full pipeline, equipment/injury/dislike
    # filtering, fatigue overlay, session trimming, determinism.
    "tests.test_plan_generation_integration",
    # Exercise fatigue: resolve_exercise_fatigue + resolve_focus_fatigue
    # — skipped sets, load factor, stimulus multipliers, PLUS_CARDIO merge.
    "tests.test_exercise_fatigue",
    # Manual-activity energy: calorie/zone-minute estimation + RPE → fatigue.
    "tests.test_activity_energy",
    # Multi-day fatigue/recovery scenarios — PPL week, back-to-back focus,
    # recovery day reduction, mixed activity types, injury boost.
    "tests.test_fatigue_scenarios",
    # Goal × split × days matrix — all 13 goals, all 5 splits, density
    # trim scaling, injury/equipment/dislike filtering, focus rotation.
    "tests.test_planner_matrix",
    # Nutrition scoring scenarios — adherence, quality sub-scores, recovery
    # flags, goal-aware weighting, confidence scaling, trend detection.
    "tests.test_nutrition_scenarios",
    # Multi-week adaptation + edge cases — overtraining detection, deload
    # recovery, impossible users, every injury, minimal equipment.
    "tests.test_adaptation_scenarios",
    # Workout templates: CRUD, free-tier cap, share-code generation,
    # preview, idempotent import, self-import block, revoke.
    "tests.test_workout_templates",
    # Manual mode (Pro-only): toggle gating, mid-week wipe, use-template
    # snapshot, clear/mark-rest, auto-renew empty-week spawn.
    "tests.test_manual_mode",
    # Guided-flow generators (yoga / stretch / foam-roll) + flow_category
    # propagation through build_planner_exercise. Pure-function, no DB.
    "tests.test_guided_flow_generators",
    # Meal-day AI evaluator: payload aggregation, empty-day short-circuit
    # (no LLM call), dedupe behavior. Live LLM call NOT exercised.
    "tests.test_meal_day_evaluator",
    # Week AI evaluator: auto vs manual mode payload tagging, manual_meta
    # counts, empty-week short-circuit, recommendations cap. No LLM call.
    "tests.test_week_evaluator",
    # Supplement Facts parsing: nutrient-name normalization, unit/IU
    # conversion, dose-scaled crediting, trace-mineral score wiring.
    "tests.test_supplement_facts",
    # 2026-05 nutrient expansion: trans fat / choline / iodine / vit K /
    # vit E / phosphorus / omega-3 subtypes / omega-6 / caffeine / alcohol.
    # Pure-function — covers field plumbing + lifestyle-flag language.
    "tests.test_nutrition_field_expansion",
    # 2026-05 cardio expansion: Edwards' TRIMP per session + weekly
    # rollup + cardio progression sub-pillar in the fitness score.
    "tests.test_cardio_load",
    # 2026-05 engagement: workout / meal / readiness streaks with
    # one-day grace + within-window best.
    "tests.test_streaks",
    # 2026-05 trainer context expansion: HRV / sleep last night / cardio
    # load / caffeine+alcohol / fiber micros + intent classifiers for
    # energy / fueling / nutrient questions.
    "tests.test_trainer_context_expansion",
    # 2026-05 regression: pre-set recommender silently held load when a
    # user under-repped every set last session. Now flags majority_missed
    # and surfaces action=reduce_load with a meaningful weight drop.
    "tests.test_weight_recommendation_underrep",
    # 2026-05 audit: every demo_resolver override must point at a
    # bundled asset folder. Locks the 9 audit fixes + 2 wrong overrides
    # so future edits can't silently rebreak the thumbnails.
    "tests.test_demo_resolver_overrides",
    # 2026-05 lifestyle-activity TDEE nudge: step_2b modifier behavior
    # + end-to-end thread through CalorieInputs → compute_targets.
    "tests.test_lifestyle_activity_modifier",
    # End-to-end HTTP smoke — requires backend running at localhost:8000.
    # Skipped automatically when the server isn't up; see test_api_smoke.py.
    "tests.test_api_smoke",
)


def main() -> int:
    failures = 0
    for module_name in _TEST_MODULES:
        print()
        print("#" * 64)
        print(f"#  {module_name}")
        print("#" * 64)
        try:
            mod = importlib.import_module(module_name)
        except Exception as e:
            print(f"  ✗ IMPORT ERROR: {e}")
            traceback.print_exc()
            failures += 1
            continue

        cases = getattr(mod, "cases", None) or _discover_cases(mod)
        if not cases:
            print(f"  (no test cases discovered in {module_name})")
            continue

        for case in cases:
            try:
                case()
            except AssertionError as e:
                print(f"  ✗ FAIL [{case.__name__}]: {e}")
                failures += 1
            except Exception as e:
                print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
                failures += 1

    print()
    print("=" * 64)
    if failures:
        print(f"  {failures} test(s) FAILED across all modules")
        return 1
    print("  All test suites passed.")
    return 0


def _discover_cases(mod) -> list:
    """Pick up every top-level `test_*` callable from a module."""
    return [
        getattr(mod, name)
        for name in dir(mod)
        if name.startswith("test_") and callable(getattr(mod, name))
    ]


if __name__ == "__main__":
    sys.exit(main())
