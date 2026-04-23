"""Food classifier — normalize + deterministic + heuristic.

Pipeline: normalize_name → classify_deterministic → classify_heuristic → unknown.
AI fallback is invoked separately (see `ai_classify.py`) only for rows whose
deterministic+heuristic pass returned source="unknown".

All outputs are explainable and conservative. When a food has multiple plant
ingredients (e.g., "mixed berries"), we return the list — but only for items
we can verify from the name alone. We prefer "unknown" over hallucination.

Bump CLASSIFIER_VERSION when the logic changes materially — the backfill
job uses the version to decide which rows need reprocessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

CLASSIFIER_VERSION = 1

Source = Literal["deterministic", "heuristic", "ai", "unknown"]
ProcessingBucket = Literal["minimally_processed", "processed", "ultra_processed", "unknown"]


@dataclass
class FoodClassification:
    normalized_name: str
    display_name: str
    likely_plant_foods: list[str]   # coarse slugs; [] = no plant detected
    plant_count_value: int
    fermented_flag: bool
    omega3_flag: bool
    processing_bucket: ProcessingBucket
    confidence: float               # 0..1
    source: Source
    notes: str | None = None


# ── Normalization ────────────────────────────────────────────────────────────

_BRAND_NOISE = re.compile(
    r"\b(organic|fresh|frozen|raw|cooked|plain|whole|low[- ]fat|fat[- ]free|sugar[- ]free|"
    r"unsweetened|sweetened|natural|premium|classic|homemade|store[- ]bought|keto|"
    r"gluten[- ]free|non[- ]gmo|grass[- ]fed|wild[- ]caught|pasture[- ]raised|"
    r"grade a|usda|extra virgin|virgin|pure|real|kirkland|trader joe'?s|"
    r"whole foods|365)\b",
    re.IGNORECASE,
)

_MULTISPACE = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s&/-]")

def normalize_name(raw: str) -> str:
    """Lowercase, strip punctuation, drop common brand/marketing noise.

    We keep hyphens/slashes since they often carry meaning ("greek-yogurt",
    "soy/tofu"). We intentionally preserve the essential noun — this is NOT
    a stemmer; pluralization is partially handled downstream where it matters.
    """
    if not raw:
        return ""
    n = raw.lower().strip()
    n = _PUNCT.sub(" ", n)
    n = _BRAND_NOISE.sub(" ", n)
    n = _MULTISPACE.sub(" ", n).strip()
    # Singularize common plurals at word boundaries: berries → berry, tomatoes → tomato
    n = re.sub(r"\b(\w+?)ies\b", r"\1y", n)
    n = re.sub(r"\b(\w+?)oes\b", r"\1o", n)
    n = re.sub(r"\b(\w+?)ves\b", r"\1f", n)
    n = re.sub(r"\b(\w+?)s\b", r"\1", n) if len(n) > 3 else n
    return n.strip()


# ── Plant diversity tables ───────────────────────────────────────────────────
#
# Each key is a canonical plant slug. Values are name fragments to match in
# normalized form. Composite items (e.g. "smoothie") are intentionally absent
# — we don't guess their contents. Herbs/spices are kept conservative (only
# common, visually-distinct ones) to avoid double-counting seasoning.

_PLANT_LEXICON: dict[str, list[str]] = {
    # Fruits
    "apple": ["apple"], "banana": ["banana"], "blueberry": ["blueberry"],
    "raspberry": ["raspberry"], "strawberry": ["strawberry"], "blackberry": ["blackberry"],
    "cherry": ["cherry"], "grape": ["grape"], "orange": ["orange"], "lemon": ["lemon"],
    "lime": ["lime"], "peach": ["peach"], "pear": ["pear"], "plum": ["plum"],
    "mango": ["mango"], "pineapple": ["pineapple"], "kiwi": ["kiwi"],
    "watermelon": ["watermelon"], "cantaloupe": ["cantaloupe"], "pomegranate": ["pomegranate"],
    "avocado": ["avocado"], "coconut": ["coconut"], "fig": ["fig"], "date": ["date fruit", " date "],
    "cranberry": ["cranberry"],
    # Vegetables
    "spinach": ["spinach"], "kale": ["kale"], "arugula": ["arugula"],
    "lettuce": ["lettuce", "romaine"], "broccoli": ["broccoli"], "cauliflower": ["cauliflower"],
    "carrot": ["carrot"], "tomato": ["tomato"], "cucumber": ["cucumber"],
    "bell_pepper": ["bell pepper", "red pepper", "yellow pepper", "green pepper"],
    "onion": ["onion", "shallot"], "garlic": ["garlic"], "zucchini": ["zucchini"],
    "squash": ["squash", "butternut"], "sweet_potato": ["sweet potato", "yam"],
    "potato": ["potato"], "mushroom": ["mushroom"], "celery": ["celery"],
    "asparagus": ["asparagus"], "brussels_sprout": ["brussels sprout"],
    "cabbage": ["cabbage"], "eggplant": ["eggplant", "aubergine"],
    "beet": ["beet"], "corn": ["corn"], "green_bean": ["green bean"],
    "pea": ["pea "], "edamame": ["edamame"],
    # Legumes
    "chickpea": ["chickpea", "garbanzo"], "black_bean": ["black bean"],
    "kidney_bean": ["kidney bean"], "pinto_bean": ["pinto bean"],
    "lentil": ["lentil"], "white_bean": ["white bean", "cannellini", "navy bean"],
    "soy": ["soybean", "soy "], "tofu": ["tofu"], "tempeh": ["tempeh"],
    # Whole grains
    "oat": ["oat", "oatmeal"], "quinoa": ["quinoa"], "brown_rice": ["brown rice"],
    "wild_rice": ["wild rice"], "barley": ["barley"], "buckwheat": ["buckwheat"],
    "farro": ["farro"], "bulgur": ["bulgur"], "millet": ["millet"],
    "whole_wheat": ["whole wheat", "whole grain"],
    # Nuts
    "almond": ["almond"], "walnut": ["walnut"], "cashew": ["cashew"],
    "pecan": ["pecan"], "pistachio": ["pistachio"], "hazelnut": ["hazelnut"],
    "macadamia": ["macadamia"], "brazil_nut": ["brazil nut"], "peanut": ["peanut"],
    # Seeds
    "chia": ["chia"], "flax": ["flax", "flaxseed"], "pumpkin_seed": ["pumpkin seed", "pepita"],
    "sunflower_seed": ["sunflower seed"], "sesame": ["sesame", "tahini"],
    "hemp_seed": ["hemp seed", "hemp heart"],
    # Herbs/spices (conservative — only clearly distinct, named ones)
    "basil": ["basil"], "cilantro": ["cilantro", "coriander"], "parsley": ["parsley"],
    "mint": ["mint"], "rosemary": ["rosemary"], "thyme": ["thyme"],
    "turmeric": ["turmeric"], "ginger": ["ginger"], "cinnamon": ["cinnamon"],
}

# Fragments that are strongly NOT a plant detection (negations).
_PLANT_NEGATIVES = [
    "flavor", "flavored", "artificial", "extract", "candy", "gummy",
]

# Slug category → used by scorers to prefer diversity of categories
PLANT_CATEGORY: dict[str, str] = {}
for _cat, _slugs in {
    "fruit": ["apple","banana","blueberry","raspberry","strawberry","blackberry","cherry","grape",
              "orange","lemon","lime","peach","pear","plum","mango","pineapple","kiwi","watermelon",
              "cantaloupe","pomegranate","avocado","coconut","fig","date","cranberry"],
    "vegetable": ["spinach","kale","arugula","lettuce","broccoli","cauliflower","carrot","tomato",
                  "cucumber","bell_pepper","onion","garlic","zucchini","squash","sweet_potato",
                  "potato","mushroom","celery","asparagus","brussels_sprout","cabbage","eggplant",
                  "beet","corn","green_bean","pea","edamame"],
    "legume": ["chickpea","black_bean","kidney_bean","pinto_bean","lentil","white_bean","soy","tofu","tempeh"],
    "whole_grain": ["oat","quinoa","brown_rice","wild_rice","barley","buckwheat","farro","bulgur","millet","whole_wheat"],
    "nut": ["almond","walnut","cashew","pecan","pistachio","hazelnut","macadamia","brazil_nut","peanut"],
    "seed": ["chia","flax","pumpkin_seed","sunflower_seed","sesame","hemp_seed"],
    "herb": ["basil","cilantro","parsley","mint","rosemary","thyme","turmeric","ginger","cinnamon"],
}.items():
    for _s in _slugs:
        PLANT_CATEGORY[_s] = _cat


# ── Fermented foods ──────────────────────────────────────────────────────────
# Conservative list — only foods with clear fermentation as a defining
# characteristic. "Cheese" and "bread" are intentionally excluded because the
# fermentation is non-probiotic in most consumer-grade forms.

_FERMENTED_FRAGMENTS = [
    "yogurt", "kefir", "kimchi", "sauerkraut", "miso", "tempeh",
    "kombucha", "natto", "kvass", "skyr",
    # Probiotic-style dairy that's explicitly labeled:
    "probiotic", "cultured cottage cheese", "cultured buttermilk",
]

# Things that have "cheese" in the name but aren't meaningfully fermented:
_FERMENTED_NEGATIVES = ["cheese flavor", "cheese puff", "cheez"]


# ── Omega-3 rich foods ───────────────────────────────────────────────────────
# Whole foods + supplements we can confidently flag. Plant-based omega-3 (ALA)
# sources count but are noted as notes in the classification.

_OMEGA3_WHOLE = [
    "salmon", "sardine", "anchovy", "mackerel", "herring", "trout",
    "tuna",  # modest — we still flag it
    "flax", "flaxseed", "chia", "walnut",
    "hemp seed", "hemp heart",
]
_OMEGA3_SUPPLEMENT = ["fish oil", "omega 3", "omega-3", "cod liver oil", "krill oil", "algae oil"]


# ── Processing buckets ───────────────────────────────────────────────────────
# NOVA-inspired, simplified. Strongest signals first.

_ULTRA_PROCESSED_FRAGMENTS = [
    "protein bar", "candy bar", "cookie", "chip", "cracker", "pretzel",
    "soda", "cola", "energy drink", "sports drink",
    "ice cream", "frozen meal", "tv dinner", "pop tart", "toaster pastry",
    "instant noodle", "ramen cup", "hot pocket",
    "nugget", "hot dog", "sausage stick", "jerky stick",
    "margarine", "cool whip", "creamer",
    "cereal bar", "granola bar",  # most are UPF, even "healthy" ones
    "pudding", "jello",
    "fast food", "mcdonald", "burger king", "taco bell", "wendy", "kfc",
    "breakfast sandwich",
]

_PROCESSED_FRAGMENTS = [
    "bread", "pasta", "tortilla", "bagel", "muffin",
    "cheese", "butter", "cured",
    "bacon", "ham", "sausage", "deli meat", "lunch meat",
    "canned", "canned soup", "pasta sauce", "ketchup", "mayonnaise", "salad dressing",
    "protein powder", "protein shake", "protein drink",
    "granola",  # packaged granola is typically processed
    "dried fruit",  # added sugars/oils common
]

_MINIMALLY_PROCESSED_HINTS = [
    "whole", "plain", "raw", "fresh",
]


# ── Public API ───────────────────────────────────────────────────────────────

def classify_food(raw_name: str) -> FoodClassification:
    """Deterministic + heuristic classifier. Returns source='unknown' when the
    name is too vague to classify safely."""
    normalized = normalize_name(raw_name)
    if not normalized or len(normalized) < 2:
        return FoodClassification(
            normalized_name=normalized, display_name=raw_name, likely_plant_foods=[],
            plant_count_value=0, fermented_flag=False, omega3_flag=False,
            processing_bucket="unknown", confidence=0.0, source="unknown",
            notes="empty or too short",
        )

    plants = _detect_plants(normalized)
    fermented = _detect_fermented(normalized)
    omega3 = _detect_omega3(normalized)
    bucket = _detect_processing(normalized, plants=plants, fermented=fermented)
    source, confidence, notes = _score_source(normalized, plants, fermented, omega3, bucket)

    return FoodClassification(
        normalized_name=normalized,
        display_name=raw_name,
        likely_plant_foods=plants,
        plant_count_value=len(plants),
        fermented_flag=fermented,
        omega3_flag=omega3,
        processing_bucket=bucket,
        confidence=confidence,
        source=source,
        notes=notes,
    )


def _detect_plants(n: str) -> list[str]:
    """Return plant slugs present in the normalized name.

    Caveat: for composite items like "blueberry greek yogurt" we include the
    detected plant (blueberry) — this is conservative because the plant is
    named explicitly. For items with only a category word ("smoothie", "salad")
    and no named ingredients, we return [].
    """
    for neg in _PLANT_NEGATIVES:
        if neg in n:
            return []
    found: set[str] = set()
    for slug, fragments in _PLANT_LEXICON.items():
        for frag in fragments:
            if frag in n:
                found.add(slug)
                break
    return sorted(found)


def _detect_fermented(n: str) -> bool:
    for neg in _FERMENTED_NEGATIVES:
        if neg in n:
            return False
    return any(frag in n for frag in _FERMENTED_FRAGMENTS)


def _detect_omega3(n: str) -> bool:
    return any(frag in n for frag in _OMEGA3_WHOLE + _OMEGA3_SUPPLEMENT)


def _detect_processing(n: str, *, plants: list[str], fermented: bool) -> ProcessingBucket:
    # Ultra-processed beats everything.
    for frag in _ULTRA_PROCESSED_FRAGMENTS:
        if frag in n:
            return "ultra_processed"
    # Clearly processed but not UPF.
    for frag in _PROCESSED_FRAGMENTS:
        if frag in n:
            return "processed"
    # Plant or fermented whole foods = minimally processed.
    if plants or fermented:
        return "minimally_processed"
    for hint in _MINIMALLY_PROCESSED_HINTS:
        if hint in n:
            return "minimally_processed"
    # Single-word basic proteins/fats (chicken, egg, rice w/o "white")
    simple_tokens = {
        "chicken", "beef", "turkey", "pork", "lamb", "egg", "fish",
        "rice", "milk", "water", "coffee", "tea",
    }
    tokens = set(n.split())
    if simple_tokens & tokens:
        return "minimally_processed"
    return "unknown"


def _score_source(n: str, plants: list[str], fermented: bool, omega3: bool, bucket: str) -> tuple[Source, float, str | None]:
    """Decide whether this classification is deterministic, heuristic, or unknown.

    Deterministic = one unambiguous signal we'd bet money on.
    Heuristic = matched a fragment, but the name is composite or noisy.
    Unknown = nothing matched.
    """
    if not plants and not fermented and not omega3 and bucket == "unknown":
        return "unknown", 0.0, "no signals matched"

    # Deterministic: single-ingredient name where the normalized form IS a known slug.
    if len(n.split()) <= 2 and (plants or fermented or omega3):
        return "deterministic", 0.9, None

    # Heuristic: matched but the name carries extra words.
    notes = None
    conf = 0.7
    if bucket == "unknown":
        conf = 0.55
        notes = "signal matched but processing bucket unresolved"
    return "heuristic", conf, notes
