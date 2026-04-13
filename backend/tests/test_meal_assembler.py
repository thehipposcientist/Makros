"""
Focused tests for the deterministic parts of meal_assembler.py — the bits
that don't need the OpenAI client: food matching, balanced fallback,
validation/repair, solver residual checks, and response shape.

The assembler emits a generic `meals: [...]` list (no breakfast / lunch /
dinner labels). Tests verify count + content, not slot identity.
"""
from __future__ import annotations

from app.services.meal_assembler import (
    FoodMacros,
    MealSkeleton,
    TemplateSkeleton,
    _best_allowed_match,
    _tokens,
    _balanced_meal_fallback,
    _PROTEIN_KEYWORDS,
    _food_matches_keywords,
    validate_and_repair_skeletons,
    _solver_residual,
    _solver_accepts,
    assemble_meal,
    assemble_template,
    _get_macros,
    solve_portions,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── 1. Food matching specificity ────────────────────────────────────────────

def test_match_prefers_specific_allowed_food() -> None:
    print("\n[test] food matcher prefers the more specific allowed food")
    allowed = {
        "rice":       _tokens("rice"),
        "white rice": _tokens("white rice"),
    }
    got = _best_allowed_match("1 cup white rice", allowed)
    assert got == "white rice", f"expected 'white rice', got {got!r}"
    _ok("'1 cup white rice' → 'white rice' (more tokens)")

    allowed2 = {
        "chicken":        _tokens("chicken"),
        "chicken breast": _tokens("chicken breast"),
    }
    got2 = _best_allowed_match("grilled chicken breast", allowed2)
    assert got2 == "chicken breast", f"expected 'chicken breast', got {got2!r}"
    _ok("'grilled chicken breast' → 'chicken breast'")


def test_match_exact_wins_over_subset() -> None:
    print("\n[test] exact name match beats subset match")
    allowed = {
        "rice":       _tokens("rice"),
        "fried rice": _tokens("fried rice"),
    }
    got = _best_allowed_match("rice", allowed)
    assert got == "rice", f"exact match should win, got {got!r}"
    _ok("'rice' → 'rice' exact match")


def test_match_returns_none_when_no_subset() -> None:
    print("\n[test] no match → returns None")
    allowed = {"chicken": _tokens("chicken"), "rice": _tokens("rice")}
    got = _best_allowed_match("salmon fillet", allowed)
    assert got is None, f"expected None, got {got!r}"
    _ok("'salmon fillet' against chicken/rice → None")


# ─── 2. Balanced fallback ────────────────────────────────────────────────────

def test_balanced_fallback_picks_protein_carb_veg() -> None:
    """The balanced fallback picks one of each category when available."""
    print("\n[test] balanced fallback prefers protein + carb + veg")
    allowed = ["white rice", "chicken breast", "broccoli", "olive oil"]
    picks = _balanced_meal_fallback(allowed)
    assert "chicken breast" in picks, f"no protein: {picks}"
    assert "white rice" in picks, f"no carb: {picks}"
    assert "broccoli" in picks, f"no veg: {picks}"
    _ok(f"balanced fallback → {picks}")


def test_balanced_fallback_never_returns_empty() -> None:
    """If no food matches any category we still return SOMETHING."""
    print("\n[test] balanced fallback — never returns empty")
    allowed = ["obscure_food_1", "obscure_food_2"]
    picks = _balanced_meal_fallback(allowed)
    assert picks, f"empty fallback: {picks}"
    _ok(f"obscure foods → {picks}")


# ─── 3. Validate + repair ────────────────────────────────────────────────────

def test_validate_pads_to_required_count() -> None:
    """If the AI returns fewer meals than required, pad up to required_count."""
    print("\n[test] validator pads to required_count")
    allowed = ["eggs", "oats", "chicken breast", "white rice", "broccoli", "apple"]
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="Oats bowl", index=0,
                     food_refs=["oats", "eggs"], target_fraction=1.0),
    ])
    [repaired] = validate_and_repair_skeletons([tpl], allowed, required_count=3)
    assert len(repaired.meals) == 3, f"expected 3 meals, got {len(repaired.meals)}"
    # Indices must be reassigned 0..N-1
    assert [m.index for m in repaired.meals] == [0, 1, 2]
    # Fractions must sum to 1.0 (within rounding)
    assert abs(sum(m.target_fraction for m in repaired.meals) - 1.0) < 1e-6
    _ok(f"padded to 3 meals → {[m.name for m in repaired.meals]}")


def test_validate_truncates_to_required_count() -> None:
    """Templates larger than required_count get truncated."""
    print("\n[test] validator truncates to required_count")
    allowed = ["eggs", "oats", "chicken breast", "white rice", "broccoli"]
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="A", index=0, food_refs=["eggs"], target_fraction=0.25),
        MealSkeleton(name="B", index=1, food_refs=["oats"], target_fraction=0.25),
        MealSkeleton(name="C", index=2, food_refs=["chicken breast"], target_fraction=0.25),
        MealSkeleton(name="D", index=3, food_refs=["broccoli"], target_fraction=0.25),
    ])
    [repaired] = validate_and_repair_skeletons([tpl], allowed, required_count=2)
    assert len(repaired.meals) == 2, f"expected 2 meals, got {len(repaired.meals)}"
    _ok(f"truncated to 2 meals")


def test_validate_cleans_out_of_list_foods() -> None:
    """food_refs not in the allowed list are dropped; the meal survives via fallback."""
    print("\n[test] validator drops out-of-list foods")
    allowed = ["oats", "eggs", "chicken breast", "white rice", "broccoli"]
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="Garbage meal", index=0,
                     food_refs=["unicorn meat", "dragon liver"],
                     target_fraction=1.0),
    ])
    [cleaned] = validate_and_repair_skeletons([tpl], allowed, required_count=1)
    refs = cleaned.meals[0].food_refs
    assert refs, "meal lost all foods"
    assert all(r in allowed for r in refs), f"non-allowed in refs: {refs}"
    _ok(f"garbage → fallback {refs}")


# ─── 4. Stub / low-confidence ────────────────────────────────────────────────

def test_stub_food_marked_low_confidence() -> None:
    print("\n[test] unenriched food → stub + low-confidence meal")
    food_lookup: dict[str, FoodMacros] = {
        "chicken breast": FoodMacros(
            name="Chicken Breast", serving_label="6 oz",
            serving_quantity=6, serving_unit="oz",
            calories=280, protein=53, carbs=0, fat=6,
        ),
    }
    stub = _get_macros("obscure food", food_lookup)
    assert stub.is_stub, "stub not flagged"
    _ok("missing food → is_stub=True")

    skeleton = MealSkeleton(
        name="Half-known meal", index=0,
        food_refs=["chicken breast", "obscure food"],
        target_fraction=1.0,
    )
    meal = assemble_meal(skeleton, food_lookup, 600, 45, 50, 20)
    assert meal["confidence"] == "low", f"confidence={meal['confidence']}"
    assert "obscure food" in meal["quality_debug"]["stub_foods"]
    _ok("meal with stub → confidence='low'")


# ─── 5. Solver residual accept/reject ────────────────────────────────────────

def test_solver_accept_tight_residual() -> None:
    print("\n[test] solver accepts good residual")
    foods = [
        FoodMacros("Chicken Breast", "6 oz", 6, "oz", 280, 53, 0, 6),
        FoodMacros("White Rice",     "1 cup", 1, "cup", 205, 4, 45, 0.5),
        FoodMacros("Olive Oil",      "1 tbsp", 1, "tbsp", 120, 0, 0, 14),
    ]
    mults = solve_portions(foods, 700, 55, 55, 25)
    residual = _solver_residual(foods, mults, 700, 55, 55, 25)
    assert _solver_accepts(residual), f"residual={residual}"
    _ok(f"residual within tolerance: {residual}")


def test_solver_rejects_infeasible_target() -> None:
    print("\n[test] solver rejects infeasible target")
    foods = [
        FoodMacros("Olive Oil",   "1 tbsp", 1, "tbsp", 120, 0, 0, 14),
        FoodMacros("Butter",      "1 tbsp", 1, "tbsp", 102, 0, 0, 11),
    ]
    mults = solve_portions(foods, 600, 40, 70, 20)
    residual = _solver_residual(foods, mults, 600, 40, 70, 20)
    assert not _solver_accepts(residual), (
        f"expected reject, got accept for residual={residual}"
    )
    _ok(f"infeasible → rejected, residual={residual}")


# ─── 6. Response shape ───────────────────────────────────────────────────────

def test_assemble_template_response_shape() -> None:
    """Output must be {targets, meals: [...]}. Each meal carries items + macros."""
    print("\n[test] template output shape uses generic meals[]")
    food_lookup: dict[str, FoodMacros] = {
        "oats":           FoodMacros("Oats",           "1 cup", 1, "cup", 300, 10, 54, 5),
        "eggs":           FoodMacros("Eggs",           "1 piece", 1, "piece", 78, 6, 1, 5),
        "chicken breast": FoodMacros("Chicken Breast", "6 oz", 6, "oz", 280, 53, 0, 6),
        "white rice":     FoodMacros("White Rice",     "1 cup", 1, "cup", 205, 4, 45, 0.5),
        "broccoli":       FoodMacros("Broccoli",       "1 cup", 1, "cup", 55, 4, 11, 0.5),
        "olive oil":      FoodMacros("Olive Oil",      "1 tbsp", 1, "tbsp", 120, 0, 0, 14),
    }
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="Oats bowl",    index=0,
                     food_refs=["oats", "eggs"], target_fraction=1/3),
        MealSkeleton(name="Chicken bowl", index=1,
                     food_refs=["chicken breast", "white rice", "broccoli"],
                     target_fraction=1/3),
        MealSkeleton(name="Chicken veg",  index=2,
                     food_refs=["chicken breast", "broccoli", "olive oil"],
                     target_fraction=1/3),
    ])
    out = assemble_template(tpl, food_lookup, 2200, 170, 220, 65)
    assert "targets" in out
    assert "meals" in out
    assert len(out["meals"]) == 3, f"expected 3 meals, got {len(out['meals'])}"
    assert out["targets"] == {"calories": 2200, "protein": 170, "carbs": 220, "fat": 65}
    for m in out["meals"]:
        assert "items" in m and len(m["items"]) > 0
        assert "calories" in m
        assert "confidence" in m
    _ok("template shape {targets, meals[]} OK")


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Meal assembler focused tests")
    print("=" * 60)
    cases = [
        test_match_prefers_specific_allowed_food,
        test_match_exact_wins_over_subset,
        test_match_returns_none_when_no_subset,
        test_balanced_fallback_picks_protein_carb_veg,
        test_balanced_fallback_never_returns_empty,
        test_validate_pads_to_required_count,
        test_validate_truncates_to_required_count,
        test_validate_cleans_out_of_list_foods,
        test_stub_food_marked_low_confidence,
        test_solver_accept_tight_residual,
        test_solver_rejects_infeasible_target,
        test_assemble_template_response_shape,
    ]
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
