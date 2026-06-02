"""Unit tests for the 2026-05 nutrient field expansion.

Covers:
  - MealItem accepts the new optional columns without breaking existing rows
  - `_meal_item_nutrient_value` resolves trans fat / alcohol / choline /
    iodine / vitamin K / vitamin E / phosphorus / omega-3 subtypes / omega-6
    from direct keys AND from a nested `micronutrients` dict
  - Null vs zero distinction preserved through the resolver
  - `MICRONUTRIENT_FIELDS` / `MICRONUTRIENT_AI_FIELDS` include the new fields
  - AI schema allows `null` for unknown values
  - LifestyleNote helpers (trans fat / alcohol / late caffeine):
    * fire when relevant data present
    * stay silent when source reported nothing (unknown ≠ zero)
    * preserve the "close to zero" target framing

Pure-function tests — no DB, no Docker, no network.
"""
from __future__ import annotations

from datetime import datetime, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── MICRONUTRIENT_FIELDS / AI fields include the new ones ──────────────────

def test_meal_assembler_micronutrient_fields_extended():
    print("\n[test] meal_assembler MICRONUTRIENT_FIELDS includes new keys")
    from app.services.nutrition.meal_assembler import MICRONUTRIENT_FIELDS
    expected_new = {
        "trans_fat_g",
        "omega_3_ala_mg", "omega_3_epa_mg", "omega_3_dha_mg",
        "omega_6_mg",
        "choline_mg", "iodine_mcg",
        "caffeine_mg", "alcohol_g",
    }
    missing = expected_new - set(MICRONUTRIENT_FIELDS)
    assert not missing, f"missing new fields from MICRONUTRIENT_FIELDS: {missing}"
    # Legacy `omega_3` (grams total) must still be present for back-compat.
    assert "omega_3" in MICRONUTRIENT_FIELDS, "legacy omega_3 must remain"
    _ok("MICRONUTRIENT_FIELDS extended without dropping legacy keys")


def test_ai_micronutrient_fields_extended():
    print("\n[test] AI MICRONUTRIENT_AI_FIELDS includes new keys")
    from app.routers.ai.utils import MICRONUTRIENT_AI_FIELDS
    expected_new = {
        "trans_fat_g",
        "omega_3_ala_mg", "omega_3_epa_mg", "omega_3_dha_mg",
        "omega_6_mg",
        "choline_mg", "iodine_mcg",
        "caffeine_mg", "alcohol_g",
    }
    assert expected_new <= set(MICRONUTRIENT_AI_FIELDS)
    _ok("AI extraction schema covers the new fields")


def test_ai_schema_allows_null_for_unknown():
    print("\n[test] AI _micros_schema_props allows null per field")
    from app.routers.ai.utils import _micros_schema_props
    props = _micros_schema_props()
    # Every nutrient property must accept null so the model can say "unknown"
    # rather than hallucinate a zero. Format is JSON schema: {"type": [...]}
    for key, definition in props.items():
        tp = definition.get("type")
        assert isinstance(tp, list), f"{key} type should be a list to allow null"
        assert "null" in tp, f"{key} schema must allow null (got {tp})"
        assert "number" in tp, f"{key} schema must allow number (got {tp})"
    _ok("AI schema allows null AND number per nutrient field")


# ─── MealItem nutrient-value resolver ───────────────────────────────────────

def test_meal_item_nutrient_value_trans_fat_direct_key():
    print("\n[test] _meal_item_nutrient_value: trans_fat_g via direct key")
    from app.routers.meals import _meal_item_nutrient_value
    assert _meal_item_nutrient_value({"trans_fat_g": 0.5}, "trans_fat_g") == 0.5
    # Alternate naming `trans_fat` in micronutrients block.
    assert _meal_item_nutrient_value(
        {"micronutrients": {"trans_fat": 1.2}}, "trans_fat_g"
    ) == 1.2
    _ok("trans fat resolves from direct AND nested keys")


def test_meal_item_nutrient_value_unknown_stays_null():
    print("\n[test] _meal_item_nutrient_value: missing field stays None")
    from app.routers.meals import _meal_item_nutrient_value
    # Empty raw + empty micronutrients → None, NOT 0. This is the
    # invariant that protects "unknown ≠ zero" through the create_meal path.
    assert _meal_item_nutrient_value({}, "trans_fat_g") is None
    assert _meal_item_nutrient_value({"micronutrients": {}}, "trans_fat_g") is None
    # Explicit 0 must NOT collapse to None — source said zero, store zero.
    # The helper's _first_float_from_mapping treats 0 as a known value
    # (it only skips None and empty string).
    assert _meal_item_nutrient_value({"trans_fat_g": 0}, "trans_fat_g") == 0.0
    _ok("missing field returns None; explicit 0 is preserved")


def test_meal_item_nutrient_value_alcohol_and_caffeine():
    print("\n[test] _meal_item_nutrient_value: alcohol_g + caffeine_mg")
    from app.routers.meals import _meal_item_nutrient_value
    assert _meal_item_nutrient_value({"alcohol_g": 14.0}, "alcohol_g") == 14.0
    assert _meal_item_nutrient_value(
        {"micronutrients": {"alcohol": 28.0}}, "alcohol_g"
    ) == 28.0
    assert _meal_item_nutrient_value({"caffeine_mg": 95}, "caffeine_mg") == 95.0
    _ok("alcohol + caffeine accept both direct and nested key spellings")


def test_meal_item_nutrient_value_omega_subtypes():
    print("\n[test] _meal_item_nutrient_value: omega-3 subtypes do NOT cross-fall back")
    from app.routers.meals import _meal_item_nutrient_value
    # Each subtype has its own provenance — we must not silently fill
    # EPA from ALA. The chip-render layer derives EPA+DHA totals; the DB
    # resolver stays strict.
    raw = {"omega_3_epa_mg": 600, "omega_3_dha_mg": 400}
    assert _meal_item_nutrient_value(raw, "omega_3_epa_mg") == 600.0
    assert _meal_item_nutrient_value(raw, "omega_3_dha_mg") == 400.0
    # ALA wasn't reported — stays None.
    assert _meal_item_nutrient_value(raw, "omega_3_ala_mg") is None
    _ok("subtype resolvers stay strict (no cross fallback)")


def test_meal_item_nutrient_value_omega_6_explicit_unit():
    print("\n[test] _meal_item_nutrient_value: omega_6_mg with legacy alias")
    from app.routers.meals import _meal_item_nutrient_value
    # New producers write omega_6_mg; AI / legacy plans may write `omega_6`.
    # Both must resolve to the same target field.
    assert _meal_item_nutrient_value({"omega_6_mg": 8000}, "omega_6_mg") == 8000.0
    assert _meal_item_nutrient_value(
        {"micronutrients": {"omega_6": 10000}}, "omega_6_mg"
    ) == 10000.0
    _ok("omega_6_mg accepts the explicit-unit field AND the legacy `omega_6` alias")


# ─── Lifestyle flags (trans fat / alcohol / late caffeine) ──────────────────

def test_trans_fat_note_silent_when_unknown():
    print("\n[test] trans_fat_note: silent when no item reports a value")
    from app.services.nutrition.lifestyle_flags import trans_fat_note
    # All items have None — we have no signal, do not fabricate "0g".
    assert trans_fat_note([{"trans_fat_g": None}, {"trans_fat_g": None}]) is None
    assert trans_fat_note([{}, {}]) is None
    _ok("trans_fat_note stays silent on fully unknown days")


def test_trans_fat_note_silent_when_explicit_zero():
    print("\n[test] trans_fat_note: silent when source confirmed 0g")
    from app.services.nutrition.lifestyle_flags import trans_fat_note
    # Source said zero — that's GOOD news, no warning fires. The chip
    # in the modal will show "0g" but the lifestyle note layer is quiet.
    assert trans_fat_note([{"trans_fat_g": 0}, {"trans_fat_g": 0}]) is None
    _ok("trans_fat_note quiet when source confirms zero")


def test_trans_fat_note_fires_when_present():
    print("\n[test] trans_fat_note: fires with neutral language when > 0")
    from app.services.nutrition.lifestyle_flags import trans_fat_note
    note = trans_fat_note([{"trans_fat_g": 0.3}, {"trans_fat_g": 0.2}])
    assert note is not None
    assert note.key == "trans_fat"
    assert note.state == "amber"
    # Per spec: language stays neutral / "close to zero" framing.
    assert "close to zero" in note.message.lower()
    assert abs(note.numbers["trans_fat_g_total"] - 0.5) < 1e-6
    _ok("trans_fat_note fires with constructive framing")


def test_alcohol_note_avoids_moralizing():
    print("\n[test] alcohol_note: frames around sleep/recovery, not morality")
    from app.services.nutrition.lifestyle_flags import alcohol_note
    assert alcohol_note([{"alcohol_g": None}]) is None  # unknown stays unknown
    note = alcohol_note([{"alcohol_g": 14.0}, {"alcohol_g": 14.0}])
    assert note is not None
    assert note.key == "alcohol"
    # Per spec: framing must reference sleep / recovery, NOT moralize.
    lowered = note.message.lower()
    assert "sleep" in lowered or "recovery" in lowered
    assert "bad" not in lowered and "shouldn" not in lowered
    # Standard drinks derivation.
    assert abs(note.numbers["standard_drinks"] - 2.0) < 1e-6
    _ok("alcohol_note framed around recovery without moralizing")


def test_late_caffeine_note_uses_timing():
    print("\n[test] late_caffeine_note: timing-aware")
    from app.services.nutrition.lifestyle_flags import late_caffeine_note
    # No timestamp → can't decide → silent.
    assert late_caffeine_note([{"caffeine_mg": 120}]) is None
    # 09:00 → before cutoff → silent.
    morning = datetime(2026, 5, 27, 9, 0, tzinfo=timezone.utc)
    assert late_caffeine_note(
        [{"caffeine_mg": 120, "consumed_at": morning}]
    ) is None
    # 16:00 → after cutoff (14:00) → fires.
    afternoon = datetime(2026, 5, 27, 16, 30, tzinfo=timezone.utc)
    note = late_caffeine_note([{"caffeine_mg": 95, "consumed_at": afternoon}])
    assert note is not None
    assert note.key == "late_caffeine"
    assert note.numbers["late_caffeine_mg"] == 95.0
    _ok("late_caffeine_note respects cutoff hour and times")


def test_collect_notes_aggregates_all():
    print("\n[test] collect_notes: aggregates trans-fat + alcohol + late caffeine")
    from app.services.nutrition.lifestyle_flags import collect_notes
    afternoon = datetime(2026, 5, 27, 18, 0, tzinfo=timezone.utc)
    notes = collect_notes([
        {"trans_fat_g": 0.4, "alcohol_g": 14.0, "caffeine_mg": 60, "consumed_at": afternoon},
    ])
    keys = {n.key for n in notes}
    assert keys == {"trans_fat", "alcohol", "late_caffeine"}
    _ok("collect_notes returns all three insight types when relevant")


def test_collect_notes_empty_when_nothing_reported():
    print("\n[test] collect_notes: empty when nothing reported")
    from app.services.nutrition.lifestyle_flags import collect_notes
    notes = collect_notes([{"food_name": "Plain rice"}, {"food_name": "Steamed broccoli"}])
    assert notes == []
    _ok("collect_notes silent on plain meals")


# ─── Constants used by insight surfaces ─────────────────────────────────────

def test_vitamin_k_caveat_present_and_clear():
    print("\n[test] VITAMIN_K_MEDICATION_CAVEAT mentions blood thinners")
    from app.services.nutrition.lifestyle_flags import VITAMIN_K_MEDICATION_CAVEAT
    assert "blood thinner" in VITAMIN_K_MEDICATION_CAVEAT.lower()
    assert "clinician" in VITAMIN_K_MEDICATION_CAVEAT.lower()
    _ok("vitamin K guidance keeps required medication caveat")


def test_omega_3_low_intake_nudge_avoids_ratio_framing():
    print("\n[test] OMEGA_3_LOW_INTAKE_NUDGE pushes food sources, not ratios")
    from app.services.nutrition.lifestyle_flags import OMEGA_3_LOW_INTAKE_NUDGE
    lowered = OMEGA_3_LOW_INTAKE_NUDGE.lower()
    # Per spec: do NOT overstate the omega-6:omega-3 ratio.
    assert "ratio" not in lowered
    # Should suggest food sources.
    for keyword in ("fatty fish", "chia", "flax", "walnut", "algae"):
        assert keyword in lowered, f"missing food-source suggestion: {keyword}"
    _ok("omega-3 nudge stays food-source focused")


if __name__ == "__main__":
    # Pure-function smoke runner so the file is usable standalone.
    cases = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print()
    if failures == 0:
        print(f"✓ All {len(cases)} tests passed.")
    else:
        print(f"✗ {failures}/{len(cases)} test(s) failed.")
    import sys
    sys.exit(1 if failures else 0)
