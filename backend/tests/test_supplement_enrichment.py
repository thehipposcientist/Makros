"""Supplement metadata helper tests — source-term inference + curated
detail-metadata lookup.

Run manually:
    docker exec thallo-backend python -m tests.test_supplement_enrichment
"""
from __future__ import annotations

from app.services import supplement_enrichment as svc


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_source_term_inference_covers_image_bank() -> None:
    print("\n[test] source-term inference covers source image bank")
    cases = {
        "Fish Oil Omega-3": ["fish"],
        "Vitamin D3 softgels": ["sunlight"],
        "Beetroot nitrate powder": ["beet"],
        "Vitamin C ascorbic acid": ["citrus"],
        "Lion's Mane Mushroom": ["mushroom"],
        "Collagen peptides": ["collagen"],
        "Panax Ginseng extract": ["ginseng"],
        "Fenugreek seed extract": ["fenugreek"],
        "Saffron crocin capsules": ["saffron"],
        "Tribulus terrestris": ["tribulus"],
        "Tongkat Ali root": ["root"],
        "Black Maca Root": ["root"],
        "Boron glycinate": ["capsule"],
    }
    for name, expected in cases.items():
        assert svc.infer_source_terms(name) == expected
    _ok("common food/animal source terms infer to image families")


def test_detail_metadata_infers_custom_creatine_name() -> None:
    print("\n[test] detail metadata infers custom creatine rows")
    from app.services.supplement_details import infer_detail_slug, supplement_detail_metadata

    slug = infer_detail_slug("Creatine", "Performance")
    details = supplement_detail_metadata(slug)
    assert slug == "creatine_monohydrate"
    assert "Strength and power output" in details["common_uses"]
    assert "Beef" in details["food_sources"]
    _ok("custom-name creatine resolves to common uses and food sources")


def test_detail_metadata_infers_libido_support_names() -> None:
    print("\n[test] detail metadata infers libido support rows")
    from app.services.supplement_details import infer_detail_slug, supplement_detail_metadata

    cases = {
        "Tongkat Ali": "tongkat_ali",
        "Panax Ginseng": "panax_ginseng",
        "Fenugreek Extract": "fenugreek",
        "Saffron Extract": "saffron",
        "Tribulus Terrestris": "tribulus_terrestris",
        "Horny Goat Weed": "epimedium",
        "Black Maca Root": "maca",
        "Boron": "boron",
    }
    for name, expected in cases.items():
        slug = infer_detail_slug(name)
        details = supplement_detail_metadata(slug)
        assert slug == expected
        assert details["common_uses"]
    _ok("libido-support custom names resolve to curated metadata")


cases = [
    test_source_term_inference_covers_image_bank,
    test_detail_metadata_infers_custom_creatine_name,
    test_detail_metadata_infers_libido_support_names,
]


if __name__ == "__main__":
    for case in cases:
        case()
