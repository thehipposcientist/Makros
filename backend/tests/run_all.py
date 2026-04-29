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
import sys
import traceback


_TEST_MODULES = (
    "tests.test_calorie_calculator",
    "tests.test_meal_assembler",
    # AI-free skeleton generator — replaces call_skeleton_ai by default.
    "tests.test_deterministic_skeleton",
    "tests.test_workout_planner",
    "tests.test_workout_goals",
    "tests.test_workout_archetypes",
    "tests.test_focus_differentiation",
    "tests.test_set_programming",
    "tests.test_plan_review",
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
    # PR detection: heaviest_weight / estimated_1rm / volume_record
    # emitted from /workouts/complete after set rows are written.
    "tests.test_pr_detection",
    # Weekly digest: 7-day review with sessions/volume/PRs/nutrition.
    "tests.test_weekly_digest",
    # Pure-function tests for the new deterministic services.
    "tests.test_weekly_volume",
    "tests.test_carb_distribution",
    "tests.test_quick_intents",
    "tests.test_rolling_e1rm",
    "tests.test_live_workout_recommendations",
    "tests.test_social_digest",
    # Cardio prescription — modality detection, capability hierarchy, prescription_type tagging.
    "tests.test_cardio_prescription",
    # Weekly calorie budget smoothing — formula, caps, macro redistribution.
    "tests.test_weekly_calorie_budget",
    "tests.test_plan_week",
    # Mid-week regeneration: done-day protection + split/dpw/equipment changes.
    "tests.test_plan_week_midweek_regen",
    # Goal change: no PlanWeek/PlanDay mutation, snapshot fields, review override.
    "tests.test_plan_week_goal_change",
    # PlanWeekCheckin: status, gate, idempotency, skip, recap.
    "tests.test_plan_week_checkin",
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
    # Deterministic weekly review: scenario-driven recommendations.
    "tests.test_plan_review_v2",
    # Food classifier: per-food tagging (probiotic, omega3, processing
    # bucket, protein source, v3 flags).
    "tests.test_food_classifier",
    # Allergen filter safety net: plural matching + macro re-sum
    # (real bugs found and fixed).
    "tests.test_allergen_filter",
    # Plateau detection: 4-week flat 1RM → suggestion.
    "tests.test_plateau_detection",
    # Streak + compliance coaching.
    "tests.test_streak",
    # Server-side readiness compute — pillar isolation, reweighting,
    # determinism, computed_at_ms versioning. The whole reason this
    # exists: phone+watch readiness can't drift when only the server
    # computes the score.
    "tests.test_readiness_compute",
    # Weekly recipe unit tests — pure-function coverage of lifting_recipe,
    # inject_hybrid_cardio, repair_adjacent_duplicates, predicates.
    "tests.test_weekly_recipe_unit",
    # Weekly nutrition review + feedback loop (planned vs actual, recs, apply_action).
    "tests.test_nutrition_review",
    # Density trimming + prescription dispatch + core programmer.
    "tests.test_density_and_prescriptions",
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
    # Coach chat: photo attachments + multi-turn conversation history
    # (the active-workout coach can now see a snapped photo and answer
    # follow-up questions without re-stating context).
    "tests.test_coach_chat_photos",
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
