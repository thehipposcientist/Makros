"""Unit tests for structured Supplement Facts parsing + trace-mineral wiring.

Covers:
  - supplement_facts: nutrient-name normalization, unit/IU conversion,
    nutrient_content sanitation, dose-scaled crediting
  - nutrition_score: SCORE_VERSION bump, copper/manganese display-only
    (not in the scored KEY_MICROS), boron deliberately RDA-less

Pure functions only — no DB, no network, no AI.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── normalize_nutrient_name ────────────────────────────────────────────────

def test_normalize_nutrient_name_variants():
    print("\n[test] normalize_nutrient_name: label variants → keys")
    from app.services.nutrition.supplement_facts import normalize_nutrient_name as n
    assert n("Vitamin B12") == "vitamin_b12_mcg"
    assert n("Vitamin B-12") == "vitamin_b12_mcg"
    assert n("Methylcobalamin") == "vitamin_b12_mcg"
    # B1 must not be swallowed by the B12 pattern.
    assert n("Vitamin B1") == "thiamin_b1_mg"
    assert n("Vitamin B6") == "vitamin_b6_mg"
    assert n("Folic Acid") == "folate_mcg"
    assert n("Folate") == "folate_mcg"
    assert n("Boron") == "boron_mg"
    assert n("Copper") == "copper_mg"
    assert n("Manganese") == "manganese_mg"
    assert n("Vitamin D3") == "vitamin_d_mcg"
    assert n("Zinc (as zinc picolinate)") == "zinc_mg"
    assert n("") is None
    assert n("Proprietary Blend") is None
    _ok("name variants normalize correctly")


# ─── convert_amount ─────────────────────────────────────────────────────────

def test_convert_amount_mass():
    print("\n[test] convert_amount: mass unit conversions")
    from app.services.nutrition.supplement_facts import convert_amount as c
    assert c(15, "mg", "zinc_mg") == 15.0
    assert c(200, "mcg", "selenium_mcg") == 200.0
    assert c(1, "g", "omega_3_g") == 1.0
    assert c(1000, "mg", "omega_3_g") == 1.0          # mg → g
    assert c(2, "g", "calcium_mg") == 2000.0          # g → mg
    # µg sign must not be misread as grams.
    assert c(400, "µg", "folate_mcg") == 400.0
    _ok("mg/mcg/g conversions correct")


def test_convert_amount_iu():
    print("\n[test] convert_amount: IU conversions are nutrient-specific")
    from app.services.nutrition.supplement_facts import convert_amount as c
    assert c(5000, "IU", "vitamin_d_mcg") == 125.0    # ÷40
    assert abs(c(3000, "IU", "vitamin_a_mcg") - 900.6) < 1.0
    # IU on a nutrient with no IU factor cannot be converted → 0.
    assert c(100, "IU", "zinc_mg") == 0.0
    _ok("IU conversions correct + unconvertible IU → 0")


def test_convert_amount_edge_cases():
    print("\n[test] convert_amount: zero / negative / unknown unit")
    from app.services.nutrition.supplement_facts import convert_amount as c
    assert c(0, "mg", "zinc_mg") == 0.0
    assert c(-5, "mg", "zinc_mg") == 0.0
    assert c("nope", "mg", "zinc_mg") == 0.0
    assert c(10, "mg", "not_a_micro") == 0.0
    # Unknown unit → assume the key's canonical unit (least-surprising).
    assert c(12, "", "zinc_mg") == 12.0
    _ok("edge cases handled without crashing")


# ─── sanitize_nutrient_facts ────────────────────────────────────────────────

def test_sanitize_nutrient_facts_builds_blob():
    print("\n[test] sanitize_nutrient_facts: clean blob from AI output")
    from app.services.nutrition.supplement_facts import sanitize_nutrient_facts
    blob = sanitize_nutrient_facts(
        [
            {"nutrient": "Zinc", "amount": 15, "unit": "mg", "percent_dv": 136},
            {"nutrient": "Boron", "amount": 3, "unit": "mg"},
            {"nutrient": "Zinc", "amount": 99, "unit": "mg"},   # duplicate dropped
            {"nutrient": "Mystery Blend", "amount": 5, "unit": "mg"},  # unmappable
            {"nutrient": "Copper", "amount": 0, "unit": "mg"},  # zero dropped
        ],
        {"count": 2, "unit": "capsules"},
    )
    assert blob is not None
    keys = [n["key"] for n in blob["nutrients"]]
    assert keys == ["zinc_mg", "boron_mg"], keys
    assert blob["serving_size"] == {"count": 2.0, "unit": "capsule"}
    assert blob["nutrients"][0]["percent_dv"] == 136.0
    assert blob["nutrients"][1]["percent_dv"] is None
    _ok("blob built, dupes/zeros/unmappables dropped")


def test_sanitize_nutrient_facts_empty():
    print("\n[test] sanitize_nutrient_facts: nothing usable → None")
    from app.services.nutrition.supplement_facts import sanitize_nutrient_facts
    assert sanitize_nutrient_facts([], None) is None
    assert sanitize_nutrient_facts(None, None) is None
    assert sanitize_nutrient_facts([{"nutrient": "xyz", "amount": 1}], None) is None
    _ok("empty / unmappable input → None")


# ─── credited_micros_from_content ───────────────────────────────────────────

def _multivit_blob():
    from app.services.nutrition.supplement_facts import sanitize_nutrient_facts
    return sanitize_nutrient_facts(
        [
            {"nutrient": "Zinc", "amount": 15, "unit": "mg"},
            {"nutrient": "Boron", "amount": 3, "unit": "mg"},
            {"nutrient": "Vitamin D", "amount": 1000, "unit": "IU"},
            {"nutrient": "Copper", "amount": 0.9, "unit": "mg"},
        ],
        {"count": 2, "unit": "capsule"},
    )


def test_credited_micros_serving_match():
    print("\n[test] credited_micros: count dose matching label serving")
    from app.services.nutrition.supplement_facts import credited_micros_from_content
    blob = _multivit_blob()
    # 2 capsules logged, label serving = 2 capsules → scale 1.0
    m = credited_micros_from_content(blob, 2, "capsule")
    assert abs(m["zinc_mg"] - 15) < 1e-9
    assert abs(m["boron_mg"] - 3) < 1e-9
    assert abs(m["vitamin_d_mcg"] - 25) < 1e-9     # 1000 IU ÷ 40
    assert abs(m["copper_mg"] - 0.9) < 1e-9
    # 4 capsules → 2× the label serving.
    m2 = credited_micros_from_content(blob, 4, "capsule")
    assert abs(m2["zinc_mg"] - 30) < 1e-9
    _ok("count dose scales by serving count")


def test_credited_micros_fallback_scale():
    print("\n[test] credited_micros: ambiguous dose → one serving")
    from app.services.nutrition.supplement_facts import credited_micros_from_content
    blob = _multivit_blob()
    # "serving" dose maps 1:1.
    assert abs(credited_micros_from_content(blob, 1, "serving")["zinc_mg"] - 15) < 1e-9
    assert abs(credited_micros_from_content(blob, 2, "serving")["zinc_mg"] - 30) < 1e-9
    # Mass-unit dose can't scale against a capsule serving → one serving.
    assert abs(credited_micros_from_content(blob, 500, "mg")["zinc_mg"] - 15) < 1e-9
    # Unit mismatch (tablet vs capsule serving) → one serving.
    assert abs(credited_micros_from_content(blob, 4, "tablet")["zinc_mg"] - 15) < 1e-9
    # Missing serving size → one serving.
    no_serving = {"nutrients": blob["nutrients"]}
    assert abs(credited_micros_from_content(no_serving, 4, "capsule")["zinc_mg"] - 15) < 1e-9
    _ok("ambiguous/mismatched doses credit exactly one serving")


def test_credited_micros_garbage_input():
    print("\n[test] credited_micros: malformed input is safe")
    from app.services.nutrition.supplement_facts import credited_micros_from_content
    assert credited_micros_from_content(None, 1, "serving") == {}
    assert credited_micros_from_content({}, 1, "serving") == {}
    assert credited_micros_from_content({"nutrients": "oops"}, 1, "serving") == {}
    assert credited_micros_from_content(
        {"nutrients": [{"key": "bogus_key", "amount": 5, "unit": "mg"}]}, 1, "serving"
    ) == {}
    _ok("malformed nutrient_content never crashes")


# ─── nutrition_score wiring ─────────────────────────────────────────────────

def test_score_version_bumped():
    print("\n[test] nutrition_score: SCORE_VERSION bumped to 7")
    from app.services.nutrition.nutrition_score import SCORE_VERSION
    assert SCORE_VERSION == 7, f"expected 7, got {SCORE_VERSION}"
    _ok("SCORE_VERSION == 7")


def test_trace_minerals_display_only():
    print("\n[test] nutrition_score: copper/manganese display-only, boron RDA-less")
    from app.services.nutrition.nutrition_score import RDA, KEY_MICROS, RESILIENCE_MICROS
    # Copper/manganese have display RDAs but stay out of the scored set.
    assert "copper_mg" in RDA and "manganese_mg" in RDA
    assert "copper_mg" not in KEY_MICROS
    assert "manganese_mg" not in KEY_MICROS
    assert "boron_mg" not in KEY_MICROS
    # Boron has no RDA — informational only.
    assert "boron_mg" not in RDA
    # Copper joins the recovery-flag resilience set (it has a real RDA).
    assert "copper_mg" in RESILIENCE_MICROS
    _ok("trace minerals wired without shifting the scored set")


def test_supplement_panel_credits_score_micros():
    print("\n[test] credited_micros keys line up with score RDA keys")
    from app.services.nutrition.supplement_facts import credited_micros_from_content
    from app.services.nutrition.nutrition_score import RDA
    m = credited_micros_from_content(_multivit_blob(), 1, "serving")
    # Every credited key the score cares about must be an RDA key or boron.
    for key in m:
        assert key in RDA or key == "boron_mg", f"orphan micro key: {key}"
    _ok("credited keys match the score's vocabulary")


cases = [
    test_normalize_nutrient_name_variants,
    test_convert_amount_mass,
    test_convert_amount_iu,
    test_convert_amount_edge_cases,
    test_sanitize_nutrient_facts_builds_blob,
    test_sanitize_nutrient_facts_empty,
    test_credited_micros_serving_match,
    test_credited_micros_fallback_scale,
    test_credited_micros_garbage_input,
    test_score_version_bumped,
    test_trace_minerals_display_only,
    test_supplement_panel_credits_score_micros,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Supplement Facts parsing + trace-mineral unit tests")
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
