"""Pure-function tests for the muscle-emphasis inference helper.

Run:
    docker exec -it thallo-backend python -m tests.test_emphasis_inference
"""
from __future__ import annotations

from app.services.workout.emphasis_inference import (
    EMPHASIS_TAGS, infer_emphasis,
)


def assert_eq(actual, expected, label: str) -> None:
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_includes(items, needle, label: str) -> None:
    assert needle in items, f"{label}: {needle!r} not in {items!r}"
    print(f"  ✓ {label}")


def assert_excludes(items, needle, label: str) -> None:
    assert needle not in items, f"{label}: unexpected {needle!r} in {items!r}"
    print(f"  ✓ {label}")


# ─── Chest splits ────────────────────────────────────────────────────────────

def test_incline_press_hits_upper_chest_and_front_delt():
    print("[test] incline bench → upper_chest + front_delt")
    out = infer_emphasis("Incline Barbell Press", "chest", ["shoulders", "triceps"])
    assert_includes(out, "upper_chest", "upper_chest tagged")
    assert_includes(out, "front_delt", "front_delt tagged")
    assert_excludes(out, "mid_chest", "mid_chest not double-tagged on incline")


def test_decline_press_hits_lower_chest():
    print("[test] decline press → lower_chest")
    out = infer_emphasis("Decline Barbell Bench Press", "chest", ["triceps", "shoulders"])
    assert_includes(out, "lower_chest", "lower_chest tagged")
    assert_excludes(out, "upper_chest", "not upper")


def test_flat_press_defaults_to_mid_chest():
    print("[test] flat bench → mid_chest + front_delt")
    out = infer_emphasis("Bench Press", "chest", ["shoulders", "triceps"])
    assert_includes(out, "mid_chest", "mid_chest default")
    assert_includes(out, "front_delt", "front_delt for press")


# ─── Shoulder overrides ──────────────────────────────────────────────────────

def test_lateral_raise_is_pure_side_delt():
    print("[test] lateral raise → only side_delt")
    out = infer_emphasis("Lateral Raise", "shoulders", [])
    assert_eq(out, ["side_delt"], "exact list")


def test_rear_delt_fly():
    print("[test] rear delt fly → rear_delt only")
    out = infer_emphasis("Rear Delt Fly", "shoulders", [])
    assert_eq(out, ["rear_delt"], "exact list")


def test_overhead_press_front_and_side():
    print("[test] overhead press → front_delt + side_delt")
    out = infer_emphasis("Overhead Press", "shoulders", ["triceps"])
    assert_includes(out, "front_delt", "front")
    assert_includes(out, "side_delt", "side")
    assert_excludes(out, "rear_delt", "no rear from press")


def test_face_pull_overrides_to_rear_delt():
    print("[test] face pull → rear_delt + upper_back")
    out = infer_emphasis("Face Pull", "shoulders", ["back"])
    assert_includes(out, "rear_delt", "rear")
    assert_includes(out, "upper_back", "upper_back")


def test_shrug_is_traps_only():
    print("[test] shrug → traps")
    out = infer_emphasis("Barbell Shrug", "back", [])
    assert_eq(out, ["traps"], "exact list")


# ─── Back / rows ─────────────────────────────────────────────────────────────

def test_row_hits_lats_and_upper_back():
    print("[test] bent over row → lats + upper_back")
    out = infer_emphasis("Bent Over Barbell Row", "back", ["biceps"])
    assert_includes(out, "lats", "lats tagged")
    assert_includes(out, "upper_back", "upper_back tagged")


def test_deadlift_hits_lower_back():
    print("[test] deadlift → lower_back")
    out = infer_emphasis("Barbell Deadlift", "back", ["hamstrings", "glutes"])
    assert_includes(out, "lower_back", "lower_back tagged")


def test_pullup_hits_lats():
    print("[test] pullup → lats")
    out = infer_emphasis("Pullups", "back", ["biceps"])
    assert_includes(out, "lats", "lats tagged")


def test_pullover_overrides_to_lats():
    print("[test] dumbbell pullover → lats only")
    out = infer_emphasis("Dumbbell Pullover", "back", ["chest"])
    assert_eq(out, ["lats"], "lats override")


# ─── Arms / brachialis ───────────────────────────────────────────────────────

def test_hammer_curl_hits_brachialis():
    print("[test] hammer curl → brachialis + forearms")
    out = infer_emphasis("Hammer Curls", "biceps", ["forearms"])
    assert_includes(out, "brachialis", "brachialis tagged")
    assert_includes(out, "forearms", "forearms tagged")


def test_standard_curl_no_brachialis():
    print("[test] standard barbell curl → no brachialis override")
    out = infer_emphasis("Barbell Curl", "biceps", [])
    # No rule fires for plain barbell curl — that's OK, empty is fine.
    assert "brachialis" not in out, "brachialis only for hammer/reverse"
    print(f"  ✓ no false brachialis tag (out={out})")


def test_wrist_curl_is_forearm():
    print("[test] wrist curl → forearms")
    out = infer_emphasis("Wrist Curl", "forearms", [])
    assert_eq(out, ["forearms"], "exact")


def test_farmers_walk_traps_and_forearms():
    print("[test] farmers walk → traps + forearms")
    out = infer_emphasis("Farmers Walk", "back", ["forearms"])
    assert_includes(out, "traps", "traps")
    assert_includes(out, "forearms", "forearms")


# ─── Calves ──────────────────────────────────────────────────────────────────

def test_standing_calf_is_gastroc():
    print("[test] standing calf raise → gastrocnemius")
    out = infer_emphasis("Standing Barbell Calf Raise", "calves", [])
    assert_eq(out, ["gastrocnemius"], "gastroc")


def test_seated_calf_is_soleus():
    print("[test] seated calf raise → soleus")
    out = infer_emphasis("Seated Calf Raise", "calves", [])
    assert_eq(out, ["soleus"], "soleus")


# ─── Core ────────────────────────────────────────────────────────────────────

def test_russian_twist_is_obliques():
    print("[test] russian twist → obliques")
    out = infer_emphasis("Russian Twist", "core", [])
    assert_eq(out, ["obliques"], "obliques")


def test_hanging_leg_raise_is_lower_abs():
    print("[test] hanging leg raise → lower_abs")
    out = infer_emphasis("Hanging Leg Raise", "core", [])
    assert_eq(out, ["lower_abs"], "lower_abs")


def test_face_pull_includes_rear_delt():
    print("[test] face pull case-insensitive")
    out = infer_emphasis("FACE PULL", "shoulders", [])
    assert_includes(out, "rear_delt", "still mapped")


# ─── Robustness ──────────────────────────────────────────────────────────────

def test_unknown_exercise_returns_empty_or_minimal():
    print("[test] unknown exercise — graceful empty")
    out = infer_emphasis("Some Made Up Lift", "core", [])
    assert isinstance(out, list), "list returned"
    print(f"  ✓ returns list (got {out})")


def test_no_name_returns_empty():
    print("[test] empty name → []")
    assert_eq(infer_emphasis("", "chest", []), [], "empty list")


def test_taxonomy_is_finite():
    print("[test] every override tag is in EMPHASIS_TAGS")
    from app.services.workout.emphasis_inference import _OVERRIDES
    for name, tags in _OVERRIDES.items():
        for t in tags:
            assert t in EMPHASIS_TAGS, f"{name!r} has unknown tag {t!r}"
    print(f"  ✓ all override tags valid ({len(_OVERRIDES)} overrides)")


def test_rule_output_is_in_taxonomy():
    print("[test] sample of rule outputs all in EMPHASIS_TAGS")
    samples = [
        ("Incline Dumbbell Press", "chest", ["shoulders", "triceps"]),
        ("Bent Over Barbell Row", "back", ["biceps"]),
        ("Overhead Press", "shoulders", ["triceps"]),
        ("Barbell Deadlift", "back", ["hamstrings", "glutes"]),
        ("Hammer Curls", "biceps", ["forearms"]),
        ("Romanian Deadlift", "hamstrings", ["glutes", "back"]),
    ]
    for name, prim, sec in samples:
        out = infer_emphasis(name, prim, sec)
        for tag in out:
            assert tag in EMPHASIS_TAGS, f"{name!r} produced invalid tag {tag!r}"
    print(f"  ✓ {len(samples)} rule samples all clean")


if __name__ == "__main__":
    test_incline_press_hits_upper_chest_and_front_delt()
    test_decline_press_hits_lower_chest()
    test_flat_press_defaults_to_mid_chest()
    test_lateral_raise_is_pure_side_delt()
    test_rear_delt_fly()
    test_overhead_press_front_and_side()
    test_face_pull_overrides_to_rear_delt()
    test_shrug_is_traps_only()
    test_row_hits_lats_and_upper_back()
    test_deadlift_hits_lower_back()
    test_pullup_hits_lats()
    test_pullover_overrides_to_lats()
    test_hammer_curl_hits_brachialis()
    test_standard_curl_no_brachialis()
    test_wrist_curl_is_forearm()
    test_farmers_walk_traps_and_forearms()
    test_standing_calf_is_gastroc()
    test_seated_calf_is_soleus()
    test_russian_twist_is_obliques()
    test_hanging_leg_raise_is_lower_abs()
    test_face_pull_includes_rear_delt()
    test_unknown_exercise_returns_empty_or_minimal()
    test_no_name_returns_empty()
    test_taxonomy_is_finite()
    test_rule_output_is_in_taxonomy()
    print("\n✅ test_emphasis_inference.py PASSED")
