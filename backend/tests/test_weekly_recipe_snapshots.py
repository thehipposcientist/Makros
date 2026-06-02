"""Deterministic weekly-recipe snapshot coverage.

These tests lock the planner's planned-session counting model:
selected training days are planned sessions, mobility/recovery count as
planned sessions, and PLUS_CARDIO means a lift day with a cardio
finisher rather than a dedicated cardio day.
"""
from __future__ import annotations

from app.services.workout.archetypes import ARCHETYPE_META, DayArchetype
from app.services.workout.core_programmer import (
    program_core_across_week,
    weekly_core_target,
)
from app.services.workout.day_templates import (
    archetype_display_name,
    archetype_to_slots,
    pick_split,
)
from app.services.workout.goal_profiles import goal_profile_for
from app.services.workout.planner import PlannerInputs
from app.services.workout.slots import density_adjust_slots
from app.services.workout.weekly_recipe import (
    _CARDIO_FINISHER_LIFT_ARCHETYPES,
    generate_weekly_recipe,
    summarize_weekly_recipe,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _default_split(goal: str, days: int):
    profile = goal_profile_for(goal, "intermediate", days, 60)
    if profile.planner_mode not in (
        "lifting", "fat_loss_mix", "lifting_plus_cardio", "strength",
    ):
        return None
    inputs = PlannerInputs(
        goal=goal,
        days_per_week=days,
        session_minutes=60,
        experience="intermediate",
        priority_region="balanced",
    )
    return pick_split(inputs)


def _recipe(goal: str, days: int) -> list[DayArchetype]:
    profile = goal_profile_for(goal, "intermediate", days, 60)
    split = _default_split(goal, days)
    return generate_weekly_recipe(
        profile,
        days,
        lifting_split=split,
        user_chose_split=False,
        priority_region="balanced",
        recent_focus_buckets=(),
        recent_focus_families=(),
        muscle_fatigue=None,
        user_age=30,
    )


def _summary(goal: str, days: int):
    profile = goal_profile_for(goal, "intermediate", days, 60)
    return summarize_weekly_recipe(
        _recipe(goal, days),
        target_core_days=weekly_core_target(profile.bucket, days).default,
    )


def _summary_with_core(goal: str, days: int):
    profile = goal_profile_for(goal, "intermediate", days, 60)
    recipe = _recipe(goal, days)
    generated = {
        DayArchetype.MOBILITY_FLOW,
        DayArchetype.RECOVERY_EASY,
        DayArchetype.STRESS_RELIEF_EASY,
        DayArchetype.YOGA_FLOW,
    }
    templates = []
    for idx, archetype in enumerate(recipe):
        meta = ARCHETYPE_META[archetype]
        if archetype in generated:
            templates.append((meta.default_name, None, archetype, {}))
            continue
        slots = archetype_to_slots(
            archetype,
            idx,
            days,
            session_minutes=60,
        )
        slots = density_adjust_slots(slots, 60, category=meta.category)
        templates.append((archetype_display_name(archetype, idx, recipe), slots, archetype, None))
    _, core = program_core_across_week(
        templates=templates,
        goal=profile.bucket,
        days_per_week=days,
        session_minutes=60,
        seed=0,
        return_summary=True,
    )
    return summarize_weekly_recipe(
        recipe,
        target_core_days=core.target_core_days,
        actual_core_days_generated=core.actual_core_days_generated,
        core_skip_reasons=core.core_skip_reasons,
    )


_EXPECTED_SUMMARIES = {
    "muscle_gain": {
        3: dict(lift_days=3, heavy_lift_days=1, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=0),
        4: dict(lift_days=4, heavy_lift_days=2, hypertrophy_lift_days=1, volume_lift_days=0, cardio_finisher_lift_days=1),
        5: dict(lift_days=5, heavy_lift_days=0, hypertrophy_lift_days=4, volume_lift_days=0, cardio_finisher_lift_days=1),
        6: dict(lift_days=6, heavy_lift_days=3, hypertrophy_lift_days=0, volume_lift_days=2, cardio_finisher_lift_days=1),
        7: dict(lift_days=6, heavy_lift_days=2, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=2, mobility_days=1),
    },
    "strength": {
        3: dict(lift_days=3, heavy_lift_days=2, hypertrophy_lift_days=0, volume_lift_days=1, cardio_finisher_lift_days=0),
        4: dict(lift_days=4, heavy_lift_days=2, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=0),
        5: dict(lift_days=5, heavy_lift_days=2, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=1),
        6: dict(lift_days=6, heavy_lift_days=3, hypertrophy_lift_days=0, volume_lift_days=2, cardio_finisher_lift_days=1),
        7: dict(lift_days=6, heavy_lift_days=3, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=1, mobility_days=1),
    },
    "body_recomp": {
        3: dict(lift_days=3, heavy_lift_days=0, hypertrophy_lift_days=3, volume_lift_days=0, cardio_finisher_lift_days=0),
        4: dict(lift_days=4, heavy_lift_days=1, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=1),
        5: dict(lift_days=5, heavy_lift_days=0, hypertrophy_lift_days=4, volume_lift_days=0, cardio_finisher_lift_days=1),
        6: dict(lift_days=6, heavy_lift_days=2, hypertrophy_lift_days=2, volume_lift_days=1, cardio_finisher_lift_days=1),
        7: dict(lift_days=6, heavy_lift_days=2, hypertrophy_lift_days=3, volume_lift_days=0, cardio_finisher_lift_days=1, mobility_days=1),
    },
    "fat_loss": {
        3: dict(lift_days=3, heavy_lift_days=0, hypertrophy_lift_days=2, volume_lift_days=0, cardio_finisher_lift_days=1),
        4: dict(lift_days=4, heavy_lift_days=0, hypertrophy_lift_days=3, volume_lift_days=0, cardio_finisher_lift_days=1),
        5: dict(lift_days=5, heavy_lift_days=0, hypertrophy_lift_days=3, volume_lift_days=0, cardio_finisher_lift_days=2),
        6: dict(lift_days=5, heavy_lift_days=0, hypertrophy_lift_days=3, volume_lift_days=0, cardio_finisher_lift_days=2, mobility_days=1),
        7: dict(lift_days=6, heavy_lift_days=1, hypertrophy_lift_days=3, volume_lift_days=0, cardio_finisher_lift_days=2, mobility_days=1),
    },
    "endurance": {
        3: dict(dedicated_cardio_days=2, lift_days=1, strength_maintenance_lift_days=1),
        4: dict(dedicated_cardio_days=3, lift_days=1, strength_maintenance_lift_days=1),
        5: dict(dedicated_cardio_days=4, lift_days=1, strength_maintenance_lift_days=1),
        6: dict(dedicated_cardio_days=5, lift_days=1, strength_maintenance_lift_days=1),
        7: dict(dedicated_cardio_days=6, lift_days=1, strength_maintenance_lift_days=1),
    },
    "athletic_performance": {
        3: dict(hybrid_days=2, dedicated_cardio_days=1),
        4: dict(hybrid_days=2, dedicated_cardio_days=1, lift_days=1),
        5: dict(hybrid_days=1, dedicated_cardio_days=2, lift_days=2),
        6: dict(hybrid_days=1, dedicated_cardio_days=3, lift_days=2),
        7: dict(hybrid_days=1, dedicated_cardio_days=3, lift_days=2, mobility_days=1),
    },
    "hyrox": {
        3: dict(hybrid_days=1, dedicated_cardio_days=1, lift_days=1),
        4: dict(hybrid_days=1, dedicated_cardio_days=2, lift_days=1),
        5: dict(hybrid_days=1, dedicated_cardio_days=3, lift_days=1),
        6: dict(hybrid_days=1, dedicated_cardio_days=3, lift_days=2),
        7: dict(hybrid_days=1, dedicated_cardio_days=3, lift_days=2, mobility_days=1),
    },
    "general_health": {
        3: dict(lift_days=2, cardio_finisher_lift_days=1, dedicated_cardio_days=1),
        4: dict(lift_days=2, cardio_finisher_lift_days=2, dedicated_cardio_days=1, mobility_days=1),
        5: dict(lift_days=3, cardio_finisher_lift_days=2, dedicated_cardio_days=1, mobility_days=1),
        6: dict(lift_days=3, cardio_finisher_lift_days=2, dedicated_cardio_days=2, mobility_days=1),
        7: dict(lift_days=3, cardio_finisher_lift_days=2, dedicated_cardio_days=2, mobility_days=1, recovery_days=1),
    },
    "flexibility": {
        3: dict(dedicated_cardio_days=1, mobility_days=2),
        4: dict(lift_days=1, dedicated_cardio_days=1, mobility_days=2, strength_maintenance_lift_days=1),
        5: dict(lift_days=1, dedicated_cardio_days=1, mobility_days=3, strength_maintenance_lift_days=1),
        6: dict(lift_days=1, dedicated_cardio_days=1, mobility_days=3, recovery_days=1, strength_maintenance_lift_days=1),
        7: dict(lift_days=1, dedicated_cardio_days=1, mobility_days=3, recovery_days=2, strength_maintenance_lift_days=1),
    },
    "stress_relief": {
        3: dict(dedicated_cardio_days=1, mobility_days=1, recovery_days=1),
        4: dict(dedicated_cardio_days=1, mobility_days=1, recovery_days=2),
        5: dict(dedicated_cardio_days=1, mobility_days=1, recovery_days=3),
        6: dict(dedicated_cardio_days=1, mobility_days=2, recovery_days=3),
        7: dict(dedicated_cardio_days=1, mobility_days=2, recovery_days=4),
    },
}


def _assert_common_invariants(goal: str, days: int, summary) -> None:
    assert summary.selected_planned_sessions == days, (
        f"{goal} {days}d selected sessions drifted: {summary.as_dict()}"
    )
    assert summary.passive_off_days == 7 - days, (
        f"{goal} {days}d passive off days drifted: {summary.as_dict()}"
    )
    planned_sum = (
        summary.lift_days
        + summary.dedicated_cardio_days
        + summary.hybrid_days
        + summary.mobility_days
        + summary.recovery_days
    )
    assert planned_sum == summary.selected_planned_sessions, (
        f"{goal} {days}d planned-day category sum drifted: {summary.as_dict()}"
    )
    assert summary.cardio_finisher_lift_days <= summary.lift_days
    assert summary.cardio_exposures >= (
        summary.dedicated_cardio_days + summary.cardio_finisher_lift_days
    )
    classified_lifts = (
        summary.heavy_lift_days
        + summary.hypertrophy_lift_days
        + summary.volume_lift_days
        + summary.cardio_finisher_lift_days
        + summary.strength_maintenance_lift_days
    )
    assert classified_lifts == summary.lift_days, (
        f"{goal} {days}d lift subtype counts drifted: {summary.as_dict()}"
    )


def test_weekly_recipe_planned_session_snapshots() -> None:
    print("\n[test] weekly recipe: planned-session snapshots")
    for goal, by_day in _EXPECTED_SUMMARIES.items():
        for days, expected in by_day.items():
            summary = _summary(goal, days)
            _assert_common_invariants(goal, days, summary)
            actual = summary.as_dict()
            for key, want in expected.items():
                got = actual[key]
                assert got == want, (
                    f"{goal} {days}d {key}: got {got}, want {want}; "
                    f"summary={actual}"
                )
    _ok(f"{sum(len(v) for v in _EXPECTED_SUMMARIES.values())} recipe snapshots")


def test_cardio_finisher_lifts_are_not_dedicated_cardio() -> None:
    print("\n[test] weekly recipe: CF means cardio_finisher_lift_days")
    for archetype in _CARDIO_FINISHER_LIFT_ARCHETYPES:
        assert ARCHETYPE_META[archetype].category == "lift"
    summary = _summary("body_recomp", 7)
    assert summary.cardio_finisher_lift_days == 1
    assert summary.dedicated_cardio_days == 0
    assert summary.cardio_exposures == 1
    _ok("PLUS_CARDIO is a lift subtype, not a dedicated cardio day")


def test_recomp_and_fat_loss_cardio_exposure_can_be_finishers() -> None:
    print("\n[test] weekly recipe: cardio exposure includes CF finishers")
    for goal, days_range in (("body_recomp", range(4, 8)), ("fat_loss", range(3, 8)), ("toning", range(3, 8))):
        for days in days_range:
            summary = _summary(goal, days)
            assert summary.dedicated_cardio_days == 0, summary.as_dict()
            assert summary.cardio_finisher_lift_days > 0, summary.as_dict()
            assert summary.cardio_exposures > 0, summary.as_dict()
    _ok("recomp/fat-loss cardio exposure exists even with no dedicated cardio day")


def test_default_core_targets_by_goal_and_days() -> None:
    print("\n[test] core: default target matrix")
    expected = {
        "muscle_gain": {3: 2, 4: 2, 5: 2, 6: 2, 7: 2},
        "strength": {3: 2, 4: 2, 5: 2, 6: 2, 7: 2},
        "body_recomp": {3: 2, 4: 2, 5: 3, 6: 3, 7: 3},
        "fat_loss": {3: 2, 4: 3, 5: 3, 6: 3, 7: 3},
        "toning": {3: 2, 4: 3, 5: 3, 6: 3, 7: 3},
        "endurance": {3: 2, 4: 2, 5: 3, 6: 3, 7: 3},
        "athletic_performance": {3: 2, 4: 2, 5: 3, 6: 3, 7: 3},
        "hyrox": {3: 2, 4: 2, 5: 3, 6: 3, 7: 3},
        "general_health": {3: 2, 4: 2, 5: 2, 6: 3, 7: 3},
        "maintain": {3: 2, 4: 2, 5: 2, 6: 3, 7: 3},
        "longevity": {3: 2, 4: 2, 5: 2, 6: 3, 7: 3},
        "flexibility": {3: 2, 4: 2, 5: 2, 6: 3, 7: 3},
        "stress_relief": {3: 2, 4: 2, 5: 2, 6: 3, 7: 3},
    }
    for goal, by_day in expected.items():
        for days, want in by_day.items():
            got = weekly_core_target(goal, days).default
            assert got == want, f"{goal} {days}d core target: got {got}, want {want}"
    _ok("core target defaults match goal x day matrix")


def test_core_actual_can_be_lower_than_target_with_reasons() -> None:
    print("\n[test] core: actual direct-core can be below target")
    summary = _summary_with_core("body_recomp", 7)
    assert summary.target_core_days == 3, summary.as_dict()
    assert summary.actual_core_days_generated <= summary.target_core_days
    assert summary.actual_core_days_generated == 2, summary.as_dict()
    assert summary.core_skip_reasons, summary.as_dict()
    assert set(summary.core_skip_reasons) & {
        "session_density", "lower_day", "heavy_lower", "incompatible_archetype",
    }, summary.as_dict()
    _ok(f"body_recomp 7d target={summary.target_core_days}, actual={summary.actual_core_days_generated}")


cases = [
    test_weekly_recipe_planned_session_snapshots,
    test_cardio_finisher_lifts_are_not_dedicated_cardio,
    test_recomp_and_fat_loss_cardio_exposure_can_be_finishers,
    test_default_core_targets_by_goal_and_days,
    test_core_actual_can_be_lower_than_target_with_reasons,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Weekly recipe snapshot tests")
    print("=" * 60)
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL: {e}")
            failures += 1
        except Exception as e:
            print(f"  ✗ ERROR ({type(e).__name__}): {e}")
            failures += 1
    print()
    print("=" * 60)
    print(f"  {len(cases) - failures}/{len(cases)} passed")
    print("=" * 60)
    raise SystemExit(0 if failures == 0 else 1)
