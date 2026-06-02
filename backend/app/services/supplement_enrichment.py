"""Deterministic supplement metadata helpers.

Source-term inference (which food/animal image family backs a
supplement) and evidence→confidence mapping. Used by the add-to-stack
and update-stack paths in `routers/supplements.py`.
"""
from __future__ import annotations

import re
from typing import Any

EVIDENCE_TO_CONFIDENCE = {
    "strong": "high",
    "moderate": "medium",
    "limited": "low",
    "weak": "low",
}

SOURCE_TERM_ALIASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fish", ("omega 3", "omega3", "fish oil", "epa", "dha", "cod liver", "krill", "fish", "salmon", "seafood", "fatty acid")),
    ("milk", ("whey", "casein", "milk protein", "milk", "dairy", "lactose", "cow", "colostrum")),
    ("yogurt", ("probiotic", "probiotics", "lactobacillus", "bifidobacterium", "cfu", "yogurt", "kefir", "gut health")),
    ("egg", ("egg", "eggs", "egg protein", "albumin", "ovalbumin")),
    ("chicken", ("chicken", "poultry", "chicken protein", "bone broth chicken")),
    ("beef", ("beef", "red meat", "bovine", "beef protein", "desiccated liver", "liver extract")),
    ("pea", ("plant protein", "pea protein", "soy protein", "rice protein", "hemp protein", "vegan protein", "plant based protein", "legume", "legumes")),
    ("fenugreek", ("fenugreek", "fenugreek seed", "fenugreek seeds", "trigonella")),
    ("seed", ("almond", "almonds", "nut", "nuts", "seed", "seeds", "pumpkin seed", "flax", "flaxseed", "chia", "hemp seed", "sunflower seed")),
    ("fiber", ("psyllium", "fiber", "fibre", "soluble fiber", "inulin", "oat", "oats", "regularity")),
    ("coffee", ("caffeine", "coffee", "espresso", "stimulant")),
    ("tea", ("green tea", "egcg", "theanine", "l theanine", "l-theanine", "tea extract", "tea")),
    ("cherry", ("tart cherry", "cherry", "anthocyanin", "anthocyanins")),
    ("cranberry", ("cranberry", "cranberries", "urinary tract", "urinary")),
    ("watermelon", ("citrulline", "l citrulline", "l-citrulline", "citrulline malate", "watermelon")),
    ("sunlight", ("vitamin d", "vitamin d3", "d3", "cholecalciferol", "sunlight", "sunshine", "sun exposure")),
    ("leafy", ("folate", "folic acid", "methylfolate", "vitamin k", "vitamin k2", "k2", "spinach", "kale", "leafy green", "leafy greens")),
    ("banana", ("potassium", "banana", "bananas")),
    ("avocado", ("vitamin e", "tocopherol", "avocado", "healthy fat")),
    ("mushroom", ("mushroom", "mushrooms", "fungi", "ergocalciferol", "vitamin d2", "d2", "lion mane", "lion's mane", "reishi", "cordyceps")),
    ("beet", ("beet", "beets", "beetroot", "beet root", "beet juice", "nitrate", "nitrates")),
    ("citrus", ("vitamin c", "ascorbic acid", "citrus", "orange", "oranges", "lemon", "lemons")),
    ("cocoa", ("cocoa", "cacao", "dark chocolate", "chocolate", "flavanol", "flavanols")),
    ("ginseng", ("panax ginseng", "asian ginseng", "red ginseng", "korean ginseng", "ginseng root")),
    ("saffron", ("saffron", "crocus sativus", "crocin", "crocins", "safranal")),
    ("tribulus", ("tribulus", "tribulus terrestris", "puncture vine", "protodioscin")),
    ("root", ("maca", "maca root", "black maca", "black maca root", "lepidium meyenii", "tongkat", "tongkat ali", "eurycoma", "eurycoma longifolia", "long jack", "malaysian ginseng")),
    ("capsule", ("capsule", "capsules", "pill", "pills", "multivitamin", "vitamin", "b12", "zinc", "magnesium", "iron", "calcium", "mineral", "electrolyte", "electrolytes", "zma", "selenium", "iodine", "copper", "boron", "coq10", "nac", "melatonin", "inositol")),
    ("herb", ("ashwagandha", "rhodiola", "turmeric", "curcumin", "ginger", "adaptogen", "herb", "herbal", "root", "berberine", "epimedium", "horny goat weed", "icariin", "yin yang huo")),
    ("garlic", ("garlic", "allicin")),
    ("collagen", ("collagen", "gelatin", "peptide", "peptides", "bone broth", "broth", "marine collagen")),
    ("powder", ("creatine", "beta alanine", "beta-alanine", "bcaa", "eaa", "glutamine", "amino acid", "taurine", "glycine", "hmb", "sodium bicarbonate", "baking soda", "pre workout", "pre-workout", "performance", "powder", "protein powder", "supplement")),
)


def confidence_from_evidence(evidence: str | None) -> str | None:
    return EVIDENCE_TO_CONFIDENCE.get(str(evidence or "").strip().lower())


def _normalize_source_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def clean_source_terms(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for term in value:
        text = _normalize_source_text(str(term or ""))[:40]
        if text and text not in out:
            out.append(text)
        if len(out) >= 3:
            break
    return out or None


def infer_source_terms(*values: Any) -> list[str] | None:
    text = _normalize_source_text(" ".join(str(v or "") for v in values if v))
    if not text:
        return None
    for term, aliases in SOURCE_TERM_ALIASES:
        if any(_normalize_source_text(alias) in text for alias in aliases):
            return [term]
    return ["powder"]
