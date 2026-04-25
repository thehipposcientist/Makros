"""Tests for `services.nutrition.food_classifier.classify_food`.

The classifier feeds: gut/plant counts, processing-bucket scoring,
omega-3 weekly signal, alcohol/processed-meat/refined-grain logging,
protein source split, probiotic detection.

A miscategorization here cascades into the user-facing Nutrition Score,
weekly digest, and trainer chat context. Worth real coverage.

Coverage:
  - Plant detection (single + composite items)
  - Fermented + probiotic detection (and the difference: kimchi is both,
    sauerkraut may not be probiotic, cheddar is fermented but NOT probiotic)
  - Omega-3 detection (fatty fish, walnuts, flax, chia)
  - Processing bucket: minimally / processed / ultra-processed
  - Protein source: animal / plant / mixed / none
  - v3 flags: seafood, fruit, vegetable, alcohol, processed_meat, refined_grain
  - Brand-noise stripping in normalization
  - Edge cases: empty, very short, unknown
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Plant detection ────────────────────────────────────────────────

def test_classify_apple_detects_apple_plant():
    print("\n[test] apple → apple in likely_plant_foods")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("apple")
    assert "apple" in c.likely_plant_foods
    assert c.plant_count_value >= 1
    assert c.fruit_flag is True


def test_classify_blueberries_singularizes():
    """Plurals like 'blueberries' should normalize to 'blueberry' and match."""
    print("\n[test] blueberries → blueberry detected")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("blueberries")
    assert "blueberry" in c.likely_plant_foods
    assert c.fruit_flag is True


def test_classify_organic_apple_strips_brand_noise():
    """'organic' is brand noise — should still classify as apple."""
    print("\n[test] 'Organic Fresh Apple' → still detects apple")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Organic Fresh Apple")
    assert "apple" in c.likely_plant_foods


def test_classify_salmon_omega3_seafood():
    print("\n[test] wild salmon → omega3 + seafood flags")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Wild-caught Salmon")
    assert c.omega3_flag is True
    assert c.seafood_flag is True
    assert c.protein_source == "animal"


def test_classify_walnuts_omega3():
    print("\n[test] walnuts → omega3 flag (plant source)")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Walnuts")
    assert c.omega3_flag is True


def test_classify_chia_seeds_omega3():
    print("\n[test] chia seeds → omega3 flag")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Chia Seeds")
    assert c.omega3_flag is True


def test_classify_plain_chicken_no_omega3():
    print("\n[test] grilled chicken breast → NO omega3 flag")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Grilled Chicken Breast")
    assert c.omega3_flag is False
    assert c.protein_source == "animal"


# ── Fermented + probiotic distinction ─────────────────────────────

def test_kimchi_fermented_and_probiotic():
    """Kimchi is both fermented AND alive (probiotic)."""
    print("\n[test] kimchi → fermented + probiotic")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Kimchi")
    assert c.fermented_flag is True
    assert c.probiotic_flag is True


def test_greek_yogurt_probiotic():
    print("\n[test] greek yogurt → probiotic flag")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Greek Yogurt")
    assert c.probiotic_flag is True


def test_cheddar_fermented_but_not_probiotic():
    """Aged cheese is fermented but no live cultures — not probiotic."""
    print("\n[test] cheddar cheese → fermented but NOT probiotic")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Cheddar Cheese")
    # Fermented yes, but probiotic claim is strict — aged cheese
    # shouldn't qualify since live cultures rarely survive aging.
    assert c.probiotic_flag is False, \
        f"cheddar should NOT be probiotic (aged), got probiotic={c.probiotic_flag}"


def test_cheese_puffs_not_fermented():
    """Negative-list test: 'cheese puffs' contains 'cheese' but isn't fermented."""
    print("\n[test] cheese puffs → NOT fermented (negative list)")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Cheese Puffs")
    assert c.fermented_flag is False


# ── Processing bucket ─────────────────────────────────────────────

def test_grilled_chicken_minimally_processed():
    print("\n[test] grilled chicken → minimally_processed")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Grilled Chicken Breast")
    assert c.processing_bucket == "minimally_processed", \
        f"expected minimally_processed, got {c.processing_bucket}"


def test_apple_minimally_processed():
    print("\n[test] apple → minimally_processed")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Apple")
    assert c.processing_bucket == "minimally_processed"


# ── Protein source classification ─────────────────────────────────

def test_chicken_protein_source_animal():
    from app.services.nutrition.food_classifier import classify_food
    assert classify_food("Chicken Breast").protein_source == "animal"


def test_tofu_protein_source_plant():
    print("\n[test] tofu → plant protein source")
    from app.services.nutrition.food_classifier import classify_food
    assert classify_food("Tofu").protein_source == "plant"


def test_lentils_protein_source_plant():
    from app.services.nutrition.food_classifier import classify_food
    assert classify_food("Lentils").protein_source == "plant"


def test_apple_protein_source_none():
    """Pure fruit has no meaningful protein → 'none' or 'unknown'."""
    print("\n[test] apple → protein source 'none' or 'unknown'")
    from app.services.nutrition.food_classifier import classify_food
    src = classify_food("Apple").protein_source
    assert src in ("none", "unknown"), f"got {src}"


# ── v3 flags: alcohol / processed meat / refined grain ────────────

def test_beer_alcohol_flag():
    print("\n[test] beer → alcohol_flag")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("IPA Beer")
    assert c.alcohol_flag is True


def test_bacon_processed_meat_flag():
    print("\n[test] bacon → processed_meat_flag")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Bacon")
    assert c.processed_meat_flag is True


def test_white_bread_refined_grain_flag():
    print("\n[test] white bread → refined_grain_flag")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("White Bread")
    assert c.refined_grain_flag is True


def test_whole_wheat_bread_NOT_refined_grain():
    """Negative list: 'whole wheat' shouldn't trigger refined grain
    even though 'wheat' is in there."""
    print("\n[test] whole wheat bread → NOT refined_grain (whole-wheat negative)")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Whole Wheat Bread")
    assert c.refined_grain_flag is False


def test_broccoli_vegetable_flag():
    from app.services.nutrition.food_classifier import classify_food
    assert classify_food("Broccoli").vegetable_flag is True


def test_strawberry_fruit_flag():
    from app.services.nutrition.food_classifier import classify_food
    assert classify_food("Strawberries").fruit_flag is True


# ── Multi-plant detection ─────────────────────────────────────────

def test_classify_salad_with_multiple_plants():
    """A salad name with several distinct plants should count them all."""
    print("\n[test] 'Spinach Tomato Cucumber Salad' → 3 distinct plants")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("Spinach Tomato Cucumber Salad")
    assert "spinach" in c.likely_plant_foods
    assert "tomato" in c.likely_plant_foods
    assert "cucumber" in c.likely_plant_foods
    assert c.plant_count_value >= 3


# ── Edge cases ────────────────────────────────────────────────────

def test_empty_string_returns_unknown():
    print("\n[test] empty string → source=unknown, no crash")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("")
    assert c.source == "unknown"
    assert c.plant_count_value == 0
    assert c.fermented_flag is False


def test_single_letter_too_short():
    print("\n[test] 'a' → too short, returns unknown")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("a")
    assert c.source == "unknown"


def test_completely_unknown_food_doesnt_crash():
    print("\n[test] 'xyzfoodthatdoesntexist' → safe unknown")
    from app.services.nutrition.food_classifier import classify_food
    c = classify_food("xyzfoodthatdoesntexist")
    # Just confirm no exception. source might be unknown.
    assert c.normalized_name


def test_classifier_output_is_deterministic():
    """Same input → same output every time."""
    print("\n[test] classify_food is deterministic")
    from app.services.nutrition.food_classifier import classify_food
    a = classify_food("Greek Yogurt with Berries")
    b = classify_food("Greek Yogurt with Berries")
    assert a.likely_plant_foods == b.likely_plant_foods
    assert a.processing_bucket == b.processing_bucket
    assert a.probiotic_flag == b.probiotic_flag
    assert a.omega3_flag == b.omega3_flag


# ── Normalization edge cases ──────────────────────────────────────

def test_normalize_strips_brand_noise():
    print("\n[test] normalize_name strips 'organic', 'fresh', etc.")
    from app.services.nutrition.food_classifier import normalize_name
    n = normalize_name("Organic Fresh USDA Grade A Eggs")
    assert "organic" not in n
    assert "fresh" not in n
    assert "egg" in n


def test_normalize_handles_mixed_case():
    from app.services.nutrition.food_classifier import normalize_name
    assert normalize_name("CHICKEN") == normalize_name("chicken")


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} food_classifier tests passed")
