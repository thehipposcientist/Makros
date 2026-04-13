"""
Focused tests for the deterministic parts of meal_assembler.py — the bits
that don't need the OpenAI client: food matching, slot repair, fallback
selection, solver residual checks, and response shape.

Run from inside the backend container:
    docker exec -it makros-backend python -m app.services.test_meal_assembler
"""
from __future__ import annotations

from app.services.meal_assembler import (
    FoodMacros,
    MealSkeleton,
    TemplateSkeleton,
    _best_allowed_match,
    _tokens,
    _slot_aware_fallback,
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
    """When both "rice" and "white rice" are allowed, a ref of "1 cup white
    rice" must resolve to "white rice" — the more specific allowed name.
    The old implementation returned whichever was first in dict order."""
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
    """Exact normalized match beats specificity — if the allowed list
    contains the exact ref name, that's the match, end of story."""
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


# ─── 2. Slot-aware fallback ──────────────────────────────────────────────────

def test_slot_fallback_breakfast_prefers_breakfast_foods() -> None:
    print("\n[test] slot fallback — breakfast prefers breakfast foods")
    allowed = ["white rice", "oats", "eggs", "broccoli", "chicken breast"]
    picks = _slot_aware_fallback("breakfast", allowed)
    assert "oats" in picks or "eggs" in picks, f"no breakfast food: {picks}"
    assert "broccoli" not in picks, f"broccoli picked for breakfast: {picks}"
    _ok(f"breakfast fallback → {picks}")


def test_slot_fallback_dinner_requires_protein() -> None:
    print("\n[test] slot fallback — dinner requires a protein")
    allowed = ["white rice", "chicken breast", "broccoli", "olive oil"]
    picks = _slot_aware_fallback("dinner", allowed)
    assert "chicken breast" in picks, f"no protein in dinner: {picks}"
    _ok(f"dinner fallback → {picks}")


def test_slot_fallback_snack_has_protein_and_second_item() -> None:
    print("\n[test] slot fallback — snack picks protein + extra")
    allowed = ["greek yogurt", "apple", "almonds"]
    picks = _slot_aware_fallback("snack", allowed)
    assert len(picks) >= 2, f"snack should have ≥2 picks: {picks}"
    _ok(f"snack fallback → {picks}")


def test_slot_fallback_never_returns_empty() -> None:
    """Even if no food matches any slot keyword, we still return SOMETHING
    from the allowed list — the solver must always have input."""
    print("\n[test] slot fallback — never returns empty")
    allowed = ["obscure_food_1", "obscure_food_2"]
    for slot in ("breakfast", "lunch", "dinner", "snack"):
        picks = _slot_aware_fallback(slot, allowed)
        assert picks, f"empty fallback for slot={slot}"
    _ok("all slots produced non-empty fallback")


# ─── 3. Slot completeness repair ─────────────────────────────────────────────

def test_validate_repairs_missing_slots() -> None:
    """If the AI drops a required slot, the validator appends a repaired
    skeleton for it using the slot-aware fallback."""
    print("\n[test] validator repairs missing slots")
    allowed = ["eggs", "oats", "chicken breast", "white rice", "broccoli", "apple"]
    # Template has breakfast + lunch but NO dinner.
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="Oats bowl", slot="breakfast",
                     food_refs=["oats", "eggs"], target_fraction=0.25),
        MealSkeleton(name="Chicken bowl", slot="lunch",
                     food_refs=["chicken breast", "white rice"], target_fraction=0.35),
    ])
    required = ["breakfast", "lunch", "dinner"]
    [repaired] = validate_and_repair_skeletons([tpl], allowed, required)
    slots = sorted(m.slot for m in repaired.meals)
    assert slots == ["breakfast", "dinner", "lunch"], f"slots={slots}"
    dinner = next(m for m in repaired.meals if m.slot == "dinner")
    # Dinner repair must contain SOME protein source — the slot-aware
    # fallback will re-pick from the allowed list if the unused pool has
    # no protein, so any protein keyword match is acceptable here.
    from app.services.meal_assembler import _PROTEIN_KEYWORDS, _food_matches_keywords
    has_protein = any(_food_matches_keywords(f, _PROTEIN_KEYWORDS) for f in dinner.food_refs)
    assert has_protein, f"dinner repair missed protein: {dinner.food_refs}"
    _ok(f"missing 'dinner' repaired → {dinner.food_refs}")


def test_validate_cleans_out_of_list_foods() -> None:
    """food_refs not in the allowed list are dropped. The meal survives
    (via fallback) but the final refs are all from the allowed list."""
    print("\n[test] validator drops out-of-list foods")
    allowed = ["oats", "eggs", "chicken breast", "white rice", "broccoli"]
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="Garbage meal", slot="dinner",
                     food_refs=["unicorn meat", "dragon liver"],
                     target_fraction=0.4),
    ])
    [cleaned] = validate_and_repair_skeletons([tpl], allowed, ["dinner"])
    refs = cleaned.meals[0].food_refs
    assert refs, "meal lost all foods"
    assert all(r in allowed for r in refs), f"non-allowed in refs: {refs}"
    _ok(f"garbage → fallback {refs}")


# ─── 4. Unenriched food handling ─────────────────────────────────────────────

def test_stub_food_marked_low_confidence() -> None:
    """When a food is missing from enrichment, `_get_macros` stubs it AND
    marks it `is_stub=True`. Assembly then flags the meal as low-confidence."""
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

    # Meal with one real food + one stub → confidence low
    skeleton = MealSkeleton(
        name="Half-known meal", slot="lunch",
        food_refs=["chicken breast", "obscure food"],
        target_fraction=0.35,
    )
    meal = assemble_meal(skeleton, food_lookup, 600, 45, 50, 20)
    assert meal["confidence"] == "low", f"confidence={meal['confidence']}"
    assert "obscure food" in meal["quality_debug"]["stub_foods"]
    _ok("meal with stub → confidence='low'")


# ─── 5. Solver residual accept/reject ────────────────────────────────────────

def test_solver_accept_tight_residual() -> None:
    """A realistic food list that CAN hit the target produces a low
    residual and passes `_solver_accepts`."""
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
    """A pathological food list (only fat, no carbs) can't hit a high-carb
    target — the solver lands far from the goal and `_solver_accepts`
    returns False. The caller can then mark the meal low-confidence."""
    print("\n[test] solver rejects infeasible target")
    foods = [
        FoodMacros("Olive Oil",   "1 tbsp", 1, "tbsp", 120, 0, 0, 14),
        FoodMacros("Butter",      "1 tbsp", 1, "tbsp", 102, 0, 0, 11),
    ]
    # Ask for 600 cal / 40g protein / 70g carbs with only fat sources.
    mults = solve_portions(foods, 600, 40, 70, 20)
    residual = _solver_residual(foods, mults, 600, 40, 70, 20)
    assert not _solver_accepts(residual), (
        f"expected reject, got accept for residual={residual}"
    )
    _ok(f"infeasible → rejected, residual={residual}")


# ─── 6. Response shape preservation ──────────────────────────────────────────

def test_assemble_template_response_shape() -> None:
    """The final template dict must contain the same top-level keys the
    frontend already consumes — targets + slot keys."""
    print("\n[test] template output shape unchanged")
    food_lookup: dict[str, FoodMacros] = {
        "oats":           FoodMacros("Oats",           "1 cup", 1, "cup", 300, 10, 54, 5),
        "eggs":           FoodMacros("Eggs",           "1 piece", 1, "piece", 78, 6, 1, 5),
        "chicken breast": FoodMacros("Chicken Breast", "6 oz", 6, "oz", 280, 53, 0, 6),
        "white rice":     FoodMacros("White Rice",     "1 cup", 1, "cup", 205, 4, 45, 0.5),
        "broccoli":       FoodMacros("Broccoli",       "1 cup", 1, "cup", 55, 4, 11, 0.5),
        "olive oil":      FoodMacros("Olive Oil",      "1 tbsp", 1, "tbsp", 120, 0, 0, 14),
    }
    tpl = TemplateSkeleton(meals=[
        MealSkeleton(name="Oats bowl",    slot="breakfast",
                     food_refs=["oats", "eggs"], target_fraction=0.25),
        MealSkeleton(name="Chicken bowl", slot="lunch",
                     food_refs=["chicken breast", "white rice", "broccoli"],
                     target_fraction=0.35),
        MealSkeleton(name="Chicken veg",  slot="dinner",
                     food_refs=["chicken breast", "broccoli", "olive oil"],
                     target_fraction=0.40),
    ])
    out = assemble_template(tpl, food_lookup, 2200, 170, 220, 65)
    assert "targets" in out
    assert "breakfast" in out and "lunch" in out and "dinner" in out
    assert out["targets"] == {"calories": 2200, "protein": 170, "carbs": 220, "fat": 65}
    for slot in ("breakfast", "lunch", "dinner"):
        meal = out[slot]
        assert "items" in meal and len(meal["items"]) > 0
        assert "calories" in meal
        assert "confidence" in meal, f"confidence missing from {slot}"
    _ok("template keys + meal confidence present")


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Meal assembler focused tests")
    print("=" * 60)
    cases = [
        test_match_prefers_specific_allowed_food,
        test_match_exact_wins_over_subset,
        test_match_returns_none_when_no_subset,
        test_slot_fallback_breakfast_prefers_breakfast_foods,
        test_slot_fallback_dinner_requires_protein,
        test_slot_fallback_snack_has_protein_and_second_item,
        test_slot_fallback_never_returns_empty,
        test_validate_repairs_missing_slots,
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
    print("\n" + "=" * 60)
    if failures:
        print(f"  {failures} test(s) FAILED")
        raise SystemExit(1)
    print(f"  All {len(cases)} tests passed.")
    print("=" * 60)
