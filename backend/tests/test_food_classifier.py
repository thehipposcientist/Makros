"""Tests for the food classifier — name normalization + AI-response parsing.

As of classifier v7 the processing bucket and every food-quality flag are
AI-authoritative (NOVA-graded) — there is no substring keyword matching to
test. What remains deterministic and unit-testable:

  - `normalize_name`     — the FoodMetadata cache-key builder.
  - `_parse_ai_classification` — validates/clamps a raw AI JSON payload.
  - `_settle_processing_bucket` — external-NOVA / AI / default precedence.
  - `empty_classification` — the transient all-unknown placeholder.

`_parse_ai_classification` is the contract boundary with the AI model: a
malformed or adversarial payload must never crash a meal-write path, and a
real food must never silently become "unknown" once `_settle_*` has run.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── normalize_name ─────────────────────────────────────────────────

def test_normalize_strips_brand_noise():
    print("\n[test] normalize_name strips 'organic', 'fresh', etc.")
    from app.services.nutrition.food_classifier import normalize_name
    n = normalize_name("Organic Fresh USDA Grade A Eggs")
    assert "organic" not in n, n
    assert "fresh" not in n, n
    assert "egg" in n, n
    _ok("brand/marketing noise removed from cache key")


def test_normalize_handles_mixed_case():
    print("\n[test] normalize_name is case-insensitive")
    from app.services.nutrition.food_classifier import normalize_name
    assert normalize_name("CHICKEN") == normalize_name("chicken")
    _ok("case folded")


def test_normalize_singularizes_plurals():
    print("\n[test] normalize_name collapses plurals onto one cache key")
    from app.services.nutrition.food_classifier import normalize_name
    assert normalize_name("blueberries") == normalize_name("blueberry")
    assert normalize_name("tomatoes") == normalize_name("tomato")
    _ok("plurals collapse to a stable key")


def test_normalize_empty_is_empty():
    print("\n[test] normalize_name('') → ''")
    from app.services.nutrition.food_classifier import normalize_name
    assert normalize_name("") == ""
    assert normalize_name("   ") == ""
    _ok("empty input handled")


# ── _parse_ai_classification ───────────────────────────────────────

def test_parse_full_payload():
    print("\n[test] _parse_ai_classification maps a complete payload")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    data = {
        "processing_bucket": "ultra_processed",
        "protein_source": "animal",
        "plant_foods": ["blueberry"],
        "plant_diversity_count": 1,
        "fermented": True,
        "probiotic": True,
        "omega3": False,
        "omega3_source": "none",
        "seafood": False,
        "fruit": True,
        "vegetable": False,
        "alcohol": False,
        "processed_meat": False,
        "refined_grain": False,
        "confidence": 0.8,
        "notes": "flavored yogurt snack",
    }
    c = _parse_ai_classification(data, "Blueberry Yogurt Snack")
    assert c.processing_bucket == "ultra_processed", c
    assert c.protein_source == "animal", c
    assert c.likely_plant_foods == ["blueberry"], c
    assert c.plant_count_value == 1, c
    assert c.fermented_flag is True and c.probiotic_flag is True, c
    assert c.fruit_flag is True, c
    assert c.source == "ai", c
    assert c.confidence == 0.8, c
    _ok("every field parsed from the AI payload")


def test_parse_clamps_confidence():
    print("\n[test] _parse_ai_classification clamps confidence to [0, 0.95]")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    high = _parse_ai_classification({"processing_bucket": "processed", "confidence": 5.0}, "x")
    low = _parse_ai_classification({"processing_bucket": "processed", "confidence": -3}, "x")
    assert high.confidence == 0.95, high
    assert low.confidence == 0.0, low
    _ok("confidence never exceeds 0.95 or drops below 0")


def test_parse_rejects_invalid_enums():
    print("\n[test] _parse_ai_classification rejects out-of-vocab enum values")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    c = _parse_ai_classification(
        {"processing_bucket": "super_ultra", "protein_source": "alien", "omega3_source": "??"},
        "mystery item",
    )
    assert c.processing_bucket == "unknown", c
    assert c.protein_source == "unknown", c
    assert c.omega3_source == "none", c
    _ok("garbage enum values fall back to safe defaults")


def test_parse_plant_count_defaults_to_list_length():
    print("\n[test] plant_count falls back to plant_foods length")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    c = _parse_ai_classification({"plant_foods": ["a", "b", "c"]}, "trail mix")
    assert c.plant_count_value == 3, c
    _ok("missing plant_diversity_count → list length")


def test_parse_plant_count_composite():
    print("\n[test] composite plant count is honored above the named list")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    # A salad: AI names no individual plants but estimates a diversity count.
    c = _parse_ai_classification(
        {"plant_foods": [], "plant_diversity_count": 4}, "mixed garden salad"
    )
    assert c.plant_count_value == 4, c
    # The count can never be smaller than the explicitly-named plants.
    c2 = _parse_ai_classification(
        {"plant_foods": ["a", "b", "c"], "plant_diversity_count": 1}, "x"
    )
    assert c2.plant_count_value == 3, c2
    _ok("composite count honored; never below named-plant count")


def test_parse_empty_payload_is_safe():
    print("\n[test] _parse_ai_classification survives an empty payload")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    c = _parse_ai_classification({}, "whatever")
    assert c.processing_bucket == "unknown", c
    assert c.protein_source == "unknown", c
    assert c.confidence == 0.0, c
    assert c.fermented_flag is False and c.alcohol_flag is False, c
    assert c.source == "ai", c
    _ok("empty/malformed payload never crashes, yields safe defaults")


def test_parse_coerces_loose_booleans():
    print("\n[test] _parse_ai_classification coerces string/int booleans")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    c = _parse_ai_classification(
        {"fermented": "true", "alcohol": 1, "seafood": "false", "fruit": 0}, "x"
    )
    assert c.fermented_flag is True, c
    assert c.alcohol_flag is True, c
    assert c.seafood_flag is False, c
    assert c.fruit_flag is False, c
    _ok("loose JSON booleans coerced consistently")


# ── plant-protein correction guard ─────────────────────────────────
# The model reliably mislabels single-ingredient plant proteins (nut/seed
# butters especially) as "mixed"/"animal". `_correct_plant_protein` downgrades
# those to "plant" — but only for an unambiguous plant name with no animal token.

def test_protein_guard_fixes_nut_seed_butters():
    print("\n[test] nut/seed butters wrongly graded 'mixed' → 'plant'")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    for name in ("peanut butter", "almond butter", "tahini", "mixed nuts", "trail mix of cashews"):
        c = _parse_ai_classification({"protein_source": "mixed"}, name)
        assert c.protein_source == "plant", (name, c.protein_source)
    _ok("nut/seed butters and nuts corrected to plant")


def test_protein_guard_fixes_animal_mislabel():
    print("\n[test] a plant food wrongly graded 'animal' → 'plant'")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    c = _parse_ai_classification({"protein_source": "animal"}, "lentils")
    assert c.protein_source == "plant", c.protein_source
    _ok("'animal' verdict on a pure plant food corrected")


def test_protein_guard_leaves_composites_alone():
    print("\n[test] a genuine plant+animal composite keeps its 'mixed' verdict")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    # Both a plant token (bean) AND an animal token (chicken) present.
    c = _parse_ai_classification({"protein_source": "mixed"}, "chicken and black bean burrito")
    assert c.protein_source == "mixed", c.protein_source
    c2 = _parse_ai_classification({"protein_source": "mixed"}, "yogurt parfait with almonds")
    assert c2.protein_source == "mixed", c2.protein_source
    _ok("composites with an animal token are not downgraded")


def test_protein_guard_no_op_on_plant_and_none():
    print("\n[test] guard never touches a correct 'plant'/'animal'/'none' verdict")
    from app.services.nutrition.ai_classify import _parse_ai_classification
    # A real animal food must stay animal even though the name has no plant token.
    assert _parse_ai_classification({"protein_source": "animal"}, "grilled salmon").protein_source == "animal"
    # 'none'/'unknown' are left as-is (guard only acts on mixed/animal).
    assert _parse_ai_classification({"protein_source": "none"}, "almond milk").protein_source == "none"
    _ok("guard only fires on a wrong mixed/animal verdict for a plant name")


# ── _settle_processing_bucket ──────────────────────────────────────

def test_settle_external_override_wins():
    print("\n[test] external NOVA override wins the processing bucket")
    from app.services.nutrition.ai_classify import _parse_ai_classification, _settle_processing_bucket
    cls = _parse_ai_classification({"processing_bucket": "ultra_processed", "confidence": 0.7}, "x")
    _settle_processing_bucket(cls, override="minimally_processed", default_bucket=None)
    assert cls.processing_bucket == "minimally_processed", cls
    assert cls.confidence >= 0.95, cls
    _ok("external grade overrides the AI grade")


def test_settle_coerces_unknown_to_default():
    print("\n[test] un-AI'd unknown bucket coerces to the supplied default")
    from app.services.nutrition.ai_classify import _settle_processing_bucket
    from app.services.nutrition.food_classifier import empty_classification
    # empty_classification = AI never ran (source="unknown").
    cls = empty_classification("x")
    _settle_processing_bucket(cls, override=None, default_bucket="ultra_processed")
    assert cls.processing_bucket == "ultra_processed", cls
    assert cls.source == "defaulted", cls
    _ok("un-AI'd unknown → supplied default, marked 'defaulted' for re-grade")


def test_settle_never_leaves_unknown():
    print("\n[test] a real food is never left with an unknown bucket")
    from app.services.nutrition.ai_classify import _settle_processing_bucket
    from app.services.nutrition.food_classifier import empty_classification
    cls = empty_classification("x")
    _settle_processing_bucket(cls, override=None, default_bucket=None)
    assert cls.processing_bucket == "processed", cls
    assert cls.source == "defaulted", cls
    _ok("un-AI'd unknown with no default → conservative 'processed'")


def test_settle_keeps_ai_source_when_ai_graded_unknown():
    print("\n[test] AI-ran-but-vague: bucket coerced, source stays 'ai'")
    from app.services.nutrition.ai_classify import _parse_ai_classification, _settle_processing_bucket
    # AI responded but the name was too vague to grade a tier. The bucket is
    # coerced so the score has a value, but source stays "ai" — re-running AI
    # on the same vague name would not help, so it must not be marked stale.
    cls = _parse_ai_classification({"processing_bucket": "unknown", "confidence": 0.15}, "my usual")
    _settle_processing_bucket(cls, override=None, default_bucket=None)
    assert cls.processing_bucket == "processed", cls
    assert cls.source == "ai", cls
    _ok("AI-graded-unknown is coerced but not flagged for re-grade")


def test_settle_leaves_real_grade_untouched():
    print("\n[test] a real AI grade is not overwritten by the default")
    from app.services.nutrition.ai_classify import _parse_ai_classification, _settle_processing_bucket
    cls = _parse_ai_classification({"processing_bucket": "minimally_processed", "confidence": 0.9}, "x")
    _settle_processing_bucket(cls, override=None, default_bucket="processed")
    assert cls.processing_bucket == "minimally_processed", cls
    assert cls.source == "ai", cls
    _ok("AI grade preserved when no override is present")


# ── empty_classification ───────────────────────────────────────────

def test_empty_classification_is_all_unknown():
    print("\n[test] empty_classification is an all-unknown placeholder")
    from app.services.nutrition.food_classifier import empty_classification
    c = empty_classification("Acme Mystery Crunch")
    assert c.processing_bucket == "unknown", c
    assert c.source == "unknown", c
    assert c.confidence == 0.0, c
    assert c.likely_plant_foods == [], c
    assert c.fermented_flag is False and c.protein_source == "unknown", c
    _ok("transient placeholder is fully unknown")


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
