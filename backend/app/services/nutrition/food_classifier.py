"""Food classifier — types + name normalization.

Classification (processing tier, plant diversity, fermented / omega-3 / etc.)
is **never** derived from substring keyword matching. It comes from:

  1. an authoritative external processing grade when one exists
     (OpenFoodFacts NOVA on the barcode path), and
  2. the AI classifier (`ai_classify.ai_classify_food`) for everything else.

See `ai_classify.get_or_create_metadata` for the live + backfill entry point.
This module only holds the shared dataclass, the cache-key `normalize_name`
helper, and the plant-slug → category reference map.

Bump CLASSIFIER_VERSION when the classification contract changes materially —
the backfill uses the version to decide which FoodMetadata rows to reprocess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# v7: substring keyword classification removed — processing bucket and all
# food-quality flags are now AI-authoritative (NOVA-preferred). Bumping the
# version invalidates every prior FoodMetadata row so it reclassifies on next
# read (or via the explicit gut backfill job).
# v8: protein_source prompt tightened — "mixed" now means an item with BOTH
# plant and animal protein; single plant foods ("mixed nuts", peanut butter)
# are "plant", not "mixed".
CLASSIFIER_VERSION = 8

Source = Literal["ai", "external", "defaulted", "unknown"]
ProcessingBucket = Literal["minimally_processed", "processed", "ultra_processed", "unknown"]
ProteinSource = Literal["plant", "animal", "mixed", "none", "unknown"]
Omega3Source = Literal["marine_epa_dha", "plant_ala", "supplement", "none"]

PROCESSING_BUCKETS: frozenset[str] = frozenset(
    {"minimally_processed", "processed", "ultra_processed", "unknown"}
)
PROTEIN_SOURCES: frozenset[str] = frozenset({"plant", "animal", "mixed", "none", "unknown"})
OMEGA3_SOURCES: frozenset[str] = frozenset(
    {"marine_epa_dha", "plant_ala", "supplement", "none"}
)


@dataclass
class FoodClassification:
    normalized_name: str
    display_name: str
    likely_plant_foods: list[str]
    plant_count_value: int
    fermented_flag: bool
    omega3_flag: bool
    processing_bucket: ProcessingBucket
    confidence: float
    source: Source
    notes: str | None = None
    protein_source: ProteinSource = "unknown"
    probiotic_flag: bool = False
    # Weekly pattern facts — seafood 2x/wk omega-3 signal, produce counts,
    # alcohol log, processed-meat freq, refined-grain freq.
    seafood_flag: bool = False
    fruit_flag: bool = False
    vegetable_flag: bool = False
    alcohol_flag: bool = False
    processed_meat_flag: bool = False
    refined_grain_flag: bool = False
    omega3_source: Omega3Source = "none"


def empty_classification(raw_name: str, *, notes: str | None = None) -> FoodClassification:
    """An all-unknown classification — used only as a transient placeholder
    when AI is unavailable. Never persisted as the final state of a food."""
    return FoodClassification(
        normalized_name=normalize_name(raw_name),
        display_name=raw_name or "",
        likely_plant_foods=[],
        plant_count_value=0,
        fermented_flag=False,
        omega3_flag=False,
        processing_bucket="unknown",
        confidence=0.0,
        source="unknown",
        notes=notes,
        protein_source="unknown",
        probiotic_flag=False,
    )


# ── Normalization ────────────────────────────────────────────────────────────
# Used only to build a stable FoodMetadata cache key — NOT for classification.

_BRAND_NOISE = re.compile(
    r"\b(organic|fresh|frozen|raw|cooked|plain|whole|low[- ]fat|fat[- ]free|sugar[- ]free|"
    r"unsweetened|sweetened|natural|premium|classic|homemade|store[- ]bought|keto|"
    r"gluten[- ]free|non[- ]gmo|grass[- ]fed|wild[- ]caught|pasture[- ]raised|"
    r"grade a|usda|extra virgin|pure|real|kirkland|trader joe'?s|"
    r"whole foods|365)\b",
    re.IGNORECASE,
)

_MULTISPACE = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s&/-]")


def normalize_name(raw: str) -> str:
    """Lowercase, strip punctuation, drop common brand/marketing noise.

    We keep hyphens/slashes since they often carry meaning ("greek-yogurt",
    "soy/tofu"). This is NOT a stemmer; pluralization is partially handled so
    the cache key collapses "berries" and "berry" onto one row.
    """
    if not raw:
        return ""
    n = raw.lower().strip()
    n = _PUNCT.sub(" ", n)
    n = _BRAND_NOISE.sub(" ", n)
    n = _MULTISPACE.sub(" ", n).strip()
    n = re.sub(r"\b(\w+?)ies\b", r"\1y", n)
    n = re.sub(r"\b(\w+?)oes\b", r"\1o", n)
    n = re.sub(r"\b(\w+?)ves\b", r"\1f", n)

    def _drop_simple_plural(match: re.Match) -> str:
        word = match.group(0)
        if word.endswith(("us", "ss", "is")):
            return word
        return word[:-1]

    n = re.sub(r"\b\w+s\b", _drop_simple_plural, n) if len(n) > 3 else n
    return n.strip()


# ── Plant slug → category reference map ──────────────────────────────────────
# A static taxonomy table used by the insight engine to count *category*
# diversity (fruit / vegetable / legume / ...) from the plant slugs the AI
# classifier returns. Not a classifier — just a lookup over known slugs.

PLANT_CATEGORY: dict[str, str] = {}
for _cat, _slugs in {
    "fruit": ["apple", "banana", "blueberry", "raspberry", "strawberry", "blackberry",
              "cherry", "grape", "orange", "lemon", "lime", "peach", "pear", "plum",
              "mango", "pineapple", "kiwi", "watermelon", "cantaloupe", "pomegranate",
              "avocado", "coconut", "fig", "date", "cranberry", "apricot", "papaya"],
    "vegetable": ["spinach", "kale", "arugula", "lettuce", "broccoli", "cauliflower",
                  "carrot", "tomato", "cucumber", "bell_pepper", "onion", "garlic",
                  "zucchini", "squash", "sweet_potato", "potato", "mushroom", "celery",
                  "asparagus", "brussels_sprout", "cabbage", "eggplant", "beet", "corn",
                  "green_bean", "pea", "edamame", "okra", "leek", "chard"],
    "legume": ["chickpea", "black_bean", "kidney_bean", "pinto_bean", "lentil",
               "white_bean", "soy", "tofu", "tempeh"],
    "whole_grain": ["oat", "quinoa", "brown_rice", "wild_rice", "barley", "buckwheat",
                    "farro", "bulgur", "millet", "whole_wheat"],
    "nut": ["almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut",
            "macadamia", "brazil_nut", "peanut"],
    "seed": ["chia", "flax", "pumpkin_seed", "sunflower_seed", "sesame", "hemp_seed"],
    "herb": ["basil", "cilantro", "parsley", "mint", "rosemary", "thyme",
             "turmeric", "ginger", "cinnamon"],
}.items():
    for _s in _slugs:
        PLANT_CATEGORY[_s] = _cat
