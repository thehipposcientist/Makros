"""Pure-function tests for the MFP food matcher.

Exercises `match_food_in_list` directly with synthetic `_Candidate`
records — no DB, no network.

Run from inside the container:
    docker exec -it thallo-backend python -m tests.test_imports_mfp_matcher
"""
from __future__ import annotations

from app.services.imports.mfp_matcher import (
    _Candidate,
    match_food_in_list,
)


def assert_eq(actual, expected, label: str) -> None:
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


# Synthetic Thallo-style food list.
_CANDIDATES = [
    _Candidate(food_id=1, name="Egg", aliases=("eggs",)),
    _Candidate(food_id=2, name="Chicken Breast", aliases=("chicken",)),
    _Candidate(food_id=3, name="Oatmeal"),
    _Candidate(food_id=4, name="Brown Rice"),
    _Candidate(food_id=5, name="White Rice"),
    _Candidate(food_id=6, name="Greek Yogurt"),
    _Candidate(food_id=7, name="Almond Butter"),
    _Candidate(food_id=8, name="Salmon Fillet"),
    _Candidate(food_id=9, name="Apple"),
    _Candidate(food_id=10, name="Banana"),
    _Candidate(food_id=11, name="Orange Juice", aliases=("OJ",)),
    _Candidate(food_id=12, name="Sweet Potato"),
    _Candidate(food_id=13, name="Whole Milk"),
    _Candidate(food_id=14, name="Olive Oil"),
]


def test_exact_match():
    print("[test] exact name match")
    m, conf = match_food_in_list("Oatmeal", _CANDIDATES)
    assert_eq(m.food_id, 3, "matched Oatmeal")
    assert_eq(conf, "exact", "exact confidence")


def test_exact_match_case_insensitive():
    print("[test] case-insensitive exact match")
    m, conf = match_food_in_list("CHICKEN BREAST", _CANDIDATES)
    assert_eq(m.food_id, 2, "matched Chicken Breast despite caps")
    assert_eq(conf, "exact", "exact confidence")


def test_alias_match():
    print("[test] alias resolution")
    m, conf = match_food_in_list("OJ", _CANDIDATES)
    assert_eq(m.food_id, 11, "matched via alias")
    assert_eq(conf, "alias", "alias confidence")


def test_fuzzy_containment_seed_in_db():
    print("[test] seed tokens ⊆ db tokens — prefer fewest extras")
    # "Rice" matches both Brown Rice and White Rice; with the 2-seed-
    # tokens rule it shouldn't match either single-token term. But
    # "Cooked Brown Rice" → Brown Rice should work.
    m, conf = match_food_in_list("cooked brown rice", _CANDIDATES)
    assert_eq(m.food_id, 4, "matched Brown Rice (stop tokens stripped)")
    assert_eq(conf, "fuzzy", "fuzzy confidence")


def test_fuzzy_containment_db_in_seed():
    print("[test] db tokens ⊆ seed tokens — verbose MFP names")
    m, conf = match_food_in_list(
        "Eggland's Best Large Egg",
        _CANDIDATES,
    )
    assert_eq(m.food_id, 1, "matched Egg even with brand+size prefix")
    assert_eq(conf, "fuzzy", "fuzzy confidence")


def test_two_token_match():
    print("[test] two-token seed → containment match")
    m, conf = match_food_in_list("Greek Yogurt Plain", _CANDIDATES)
    assert_eq(m.food_id, 6, "matched Greek Yogurt")


def test_single_generic_token_does_not_match():
    print("[test] single ambiguous token rejected")
    # "Rice" alone shouldn't match Brown Rice OR White Rice — too
    # ambiguous. Only matches when the candidate is unique.
    m, conf = match_food_in_list("Rice", _CANDIDATES)
    assert m is None, f"Rice should not match: got {m}"
    print("  ✓ ambiguous single token returns None")


def test_jaccard_fallback():
    print("[test] Jaccard fallback for partial overlap")
    # No containment match, but 2 of 3 tokens overlap with Salmon Fillet.
    m, conf = match_food_in_list("salmon fillet baked", _CANDIDATES)
    assert_eq(m.food_id, 8, "matched Salmon Fillet via Jaccard")


def test_unfamiliar_food_fuzzy_match_marked_for_review():
    print("[test] unfamiliar food may fuzzy-match — but confidence flags it")
    # "Quail Egg Croquettes" contains "egg" — reverse containment will
    # match Egg with fuzzy confidence. That's intentional: macros from
    # MFP still import correctly, and the import-status UI uses the
    # 'fuzzy' tag to flag low-confidence matches for user review.
    # The alternative (no match at all) is strictly worse — same
    # imported macros, but no food link at all.
    m, conf = match_food_in_list("Quail Egg Croquettes", _CANDIDATES)
    if m is not None:
        assert conf == "fuzzy", f"low-confidence matches must be tagged fuzzy: got {conf}"
        print(f"  ✓ matched {m.name!r} with fuzzy confidence — UI flags for review")
    else:
        print("  ✓ fell through to no-match (fallback path)")


def test_truly_unmatched_returns_none():
    print("[test] genuinely unrelated food → None")
    # No token overlap at all with the candidate set.
    m, conf = match_food_in_list("Borscht Soup", _CANDIDATES)
    assert m is None, f"Borscht has no overlap: got {m}"
    print("  ✓ no match for unrelated food")


def test_empty_input_returns_none():
    print("[test] empty / whitespace input → None")
    assert match_food_in_list("", _CANDIDATES) == (None, "none"), "empty"
    print("  ✓ empty string")
    assert match_food_in_list("   ", _CANDIDATES) == (None, "none"), "whitespace"
    print("  ✓ whitespace-only")


def test_empty_candidate_list():
    print("[test] empty candidate list → None")
    m, conf = match_food_in_list("Egg", [])
    assert m is None, "no candidates"
    print("  ✓ empty list handled")


def test_stop_token_only_input():
    print("[test] input that's only stop tokens → None")
    # "raw fresh large" — all stop tokens, no real content.
    m, conf = match_food_in_list("raw fresh large", _CANDIDATES)
    assert m is None, f"stop-token-only: got {m}"
    print("  ✓ stop-token-only returns None")


def test_punctuation_tolerance():
    print("[test] punctuation/whitespace robust")
    m, conf = match_food_in_list("Greek-Yogurt,  Plain", _CANDIDATES)
    assert_eq(m.food_id, 6, "matched despite punctuation")


def test_branded_prefix_still_matches():
    print("[test] brand prefix — 'Quaker Oatmeal' → Oatmeal")
    # Two-token seed, 1 dataset token contained → containment OK.
    m, conf = match_food_in_list("Quaker Oatmeal", _CANDIDATES)
    # Quaker + Oatmeal, db Oatmeal ⊆ seed → fuzzy.
    assert_eq(m.food_id, 3, "matched Oatmeal under brand prefix")
    assert_eq(conf, "fuzzy", "fuzzy confidence")


if __name__ == "__main__":
    test_exact_match()
    test_exact_match_case_insensitive()
    test_alias_match()
    test_fuzzy_containment_seed_in_db()
    test_fuzzy_containment_db_in_seed()
    test_two_token_match()
    test_single_generic_token_does_not_match()
    test_jaccard_fallback()
    test_unfamiliar_food_fuzzy_match_marked_for_review()
    test_truly_unmatched_returns_none()
    test_empty_input_returns_none()
    test_empty_candidate_list()
    test_stop_token_only_input()
    test_punctuation_tolerance()
    test_branded_prefix_still_matches()
    print("\n✅ test_imports_mfp_matcher.py PASSED")
