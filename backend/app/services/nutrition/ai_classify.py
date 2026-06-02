"""AI food classifier — the authoritative source for processing tier and
food-quality flags.

Classification is NEVER derived from substring keyword matching. Order of
authority for the processing bucket:

  1. An external processing grade supplied by the caller — currently the
     OpenFoodFacts NOVA grade on the barcode path (`processing_bucket_override`).
  2. The AI classifier (`ai_classify_food`), which grades by NOVA and also
     emits every food-quality flag (plants, fermented, omega-3, seafood, etc.).

Results are cached on `FoodMetadata` keyed by (normalized_name,
CLASSIFIER_VERSION) so each unique food costs at most one classification
call per version. A bumped CLASSIFIER_VERSION invalidates the cache; live
cold-miss paths and explicit maintenance backfills populate the new version.

`get_or_create_metadata` never persists `processing_bucket="unknown"` for a
real food — an un-AI'd cold miss is stored as a conservative "processed"
default with `source="defaulted"` and re-upgraded to a real AI grade the next
time AI is available.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from app.services.nutrition.food_classifier import (
    FoodClassification,
    CLASSIFIER_VERSION,
    OMEGA3_SOURCES,
    PROCESSING_BUCKETS,
    PROTEIN_SOURCES,
    empty_classification,
    normalize_name,
)

logger = logging.getLogger("app.nutrition.ai_classify")

# Conservative fallback bucket for a food we could not AI-classify. "processed"
# is the middle NOVA tier — it neither rewards (minimally_processed) nor
# punishes (ultra_processed) the food-quality score while we wait for a real
# grade. Rows stored this way carry source="defaulted" and are re-classified.
_DEFAULT_BUCKET = "processed"


# ── Full classification prompt ───────────────────────────────────────────────

_PROMPT = """You are classifying a single FOOD by its name for a nutrition app.
Grade it using the NOVA food-processing framework and return structured JSON.

Return a JSON object with EXACTLY these fields:

  "processing_bucket": one of
      "minimally_processed" — NOVA 1: whole or barely-altered foods. Fresh,
            frozen or dried fruit/vegetables, grains, legumes, nuts, seeds,
            eggs, plain meat/poultry/fish, plain milk, plain (unsweetened)
            yogurt. A cooking method alone (boiled, grilled, broiled, baked,
            roasted, steamed, raw) does NOT change the tier — "boiled egg",
            "grilled chicken" and "broiled salmon" are all minimally_processed.
      "processed" — NOVA 2 & 3: culinary ingredients (oil, butter, sugar,
            honey, maple syrup, salt) AND foods made by adding them to NOVA-1
            foods: cheese, fresh/artisan bread, canned vegetables or fish,
            cured/salted meat, and home-cooked composite dishes that rely on
            such ingredients (most soups, stir-fries, salads with dressing).
      "ultra_processed" — NOVA 4: industrial formulations with ingredients or
            additives not used in home kitchens: soft drinks, packaged salty
            snacks, candy, most breakfast cereals, instant noodles, nuggets,
            hot dogs, protein/energy/granola bars, mass-produced packaged
            bread, reconstituted meat, flavored/sweetened yogurt, fast food.
      "unknown" — ONLY when the name is not a food or is too vague to grade
            ("lunch", "snack", "my usual", "leftovers"). For any recognizable
            food you MUST pick a real tier — never return "unknown" for it.

  "protein_source": "plant" | "animal" | "mixed" | "none"
      Where the protein comes from.
        "plant"  — ALL the protein is plant-based: nuts, nut/seed butters
              (peanut butter, almond butter, tahini), seeds, legumes, beans,
              lentils, tofu, tempeh, edamame, grains, plant protein powder.
              The word "mixed" in a name ("mixed nuts", "trail mix", "mixed
              beans") does NOT make it "mixed" — it is still "plant".
        "animal" — ALL the protein is animal-based: meat, poultry, fish,
              eggs, dairy, whey/collagen.
        "mixed"  — ONLY when the SAME item genuinely contains BOTH plant and
              animal protein in meaningful amounts (a chicken-and-bean
              burrito, a yogurt-and-granola parfait, a meat-and-lentil stew).
              Never use "mixed" just because a food is processed or has added
              salt/sugar/oil.
        "none"   — negligible protein (oils, sugar, most fruit, plain
              vegetables, alcohol).

  "plant_foods": array of lowercase plant slugs clearly present in the name
      (e.g. ["blueberry","spinach"]). [] if none or unclear. Do NOT invent
      ingredients for composite names — but DO count them via the next field.

  "plant_diversity_count": integer — how many DISTINCT whole plant foods this
      item realistically contains. For named single plants this equals the
      list length. For composites estimate sensibly: a mixed salad ≈ 3, a
      stir-fry ≈ 4, a fruit smoothie ≈ 3, "mixed berries" ≈ 3. 0 for foods
      with no whole plant content.

  "fermented": true ONLY for clearly fermented foods (yogurt, kefir, kimchi,
      sauerkraut, miso, tempeh, kombucha, natto). false otherwise.

  "probiotic": true ONLY for fermented foods that still carry LIVE cultures in
      their normal consumer form (yogurt, kefir, kimchi, raw sauerkraut,
      kombucha, natto). false for cooked/heated ferments (miso soup, tempeh,
      sourdough) and pasteurized or flavored products.

  "omega3": true for fatty fish (salmon, sardine, mackerel, anchovy, herring,
      trout), flax, chia, walnuts, hemp seeds, or fish/algae oil supplements.

  "omega3_source": "marine_epa_dha" | "plant_ala" | "supplement" | "none"

  "seafood": true for any fish or shellfish.
  "fruit": true if the item is or is predominantly fruit.
  "vegetable": true if the item is or is predominantly vegetable.
  "alcohol": true for alcoholic drinks. false for non-alcoholic/zero-proof.
  "processed_meat": true for cured/smoked/processed meat (bacon, sausage,
      ham, deli meat, pepperoni, salami, hot dog, jerky).
  "refined_grain": true for refined-grain foods (white bread, white rice,
      white pasta, most crackers/cereals). false for whole-grain foods.

  "confidence": float 0.0-0.95. Your honest confidence. Use ≤ 0.2 for vague
      names; never above 0.95.

  "notes": one short sentence explaining the grade. Max one sentence.

RULES:
  1. Grade the food as actually eaten. Cooking method ≠ processing tier.
  2. Brand/marketing words ("organic", "natural", "all-natural") never change
     the tier — judge the underlying food.
  3. Never hallucinate plant ingredients not implied by the name.
  4. Respond with ONLY the JSON object. No markdown, no prose.

Food name: """


def _coerce_bool(value: Any) -> bool:
    return bool(value) if isinstance(value, (bool, int, float)) else str(value).strip().lower() in ("true", "1", "yes")


# protein_source is a high-confidence property for single-ingredient plant
# foods, but the model reliably mislabels a few as "mixed"/"animal" — notably
# nut & seed butters, which it fixates on as "mixed" because of added salt/sugar.
# We correct those deterministically. This guard is intentionally narrow: it only
# DOWNGRADES a wrong "mixed"/"animal" verdict to "plant", and only for an
# unambiguous plant-protein name that carries NO animal-protein token — so a
# genuine composite ("chicken and bean burrito") keeps its AI verdict. This is
# the one place protein_source is name-corrected; processing tier + quality flags
# remain fully AI-authoritative.
_PLANT_PROTEIN_RE = re.compile(
    r"\b("
    r"peanut butter|almond butter|cashew butter|nut butter|seed butter|"
    r"sun ?butter|sunflower butter|tahini|hummus|"
    r"almonds?|walnuts?|cashews?|pecans?|pistachios?|hazelnuts?|macadamias?|"
    r"peanuts?|pine nuts?|brazil nuts?|mixed nuts?|"
    r"chia|flax(?:seed)?|hemp seeds?|pumpkin seeds?|sunflower seeds?|sesame|"
    r"lentils?|chickpeas?|garbanzos?|edamame|tofu|tempeh|soybeans?|"
    r"black beans?|kidney beans?|pinto beans?|navy beans?|white beans?|"
    r"pea protein|soy protein|rice protein|hemp protein|plant protein|vegan protein"
    r")\b",
    re.IGNORECASE,
)
_ANIMAL_PROTEIN_RE = re.compile(
    r"\b("
    r"chicken|beef|steak|pork|turkey|lamb|veal|bison|venison|"
    r"bacon|ham|sausage|salami|pepperoni|jerky|prosciutto|"
    r"fish|salmon|tuna|cod|tilapia|halibut|trout|sardine|anchovy|mackerel|"
    r"shrimp|prawn|crab|lobster|scallop|oyster|clam|mussel|squid|"
    r"eggs?|yogurt|yoghurt|cheese|milk|whey|casein|collagen|kefir|skyr|"
    r"meat|poultry|gelatin"
    r")\b",
    re.IGNORECASE,
)


def _correct_plant_protein(raw_name: str, ai_protein: str) -> str:
    """Override an obviously-wrong "mixed"/"animal" verdict to "plant" for a
    single-ingredient plant-protein food. No-op for every other case."""
    if ai_protein not in ("mixed", "animal"):
        return ai_protein
    name = raw_name or ""
    if _PLANT_PROTEIN_RE.search(name) and not _ANIMAL_PROTEIN_RE.search(name):
        return "plant"
    return ai_protein


def _parse_ai_classification(data: dict, raw_name: str) -> FoodClassification:
    """Validate + clamp a raw AI JSON payload into a FoodClassification.

    Pure function — no network, no DB — so it is unit-testable. Unknown or
    malformed fields fall back to conservative defaults rather than raising.
    """
    normalized = normalize_name(raw_name)

    bucket = str(data.get("processing_bucket", "unknown")).strip().lower()
    if bucket not in PROCESSING_BUCKETS:
        bucket = "unknown"

    protein = str(data.get("protein_source", "unknown")).strip().lower()
    if protein not in PROTEIN_SOURCES:
        protein = "unknown"
    protein = _correct_plant_protein(raw_name, protein)

    omega3_source = str(data.get("omega3_source", "none")).strip().lower()
    if omega3_source not in OMEGA3_SOURCES:
        omega3_source = "none"

    plants_raw = data.get("plant_foods") or data.get("likely_plant_foods") or []
    if not isinstance(plants_raw, list):
        plants_raw = []
    plants = [
        str(p).strip().lower().replace(" ", "_")[:40]
        for p in plants_raw
        if isinstance(p, str) and p.strip()
    ][:20]

    try:
        plant_count = int(data.get("plant_diversity_count", len(plants)))
    except (TypeError, ValueError):
        plant_count = len(plants)
    plant_count = max(len(plants), max(0, min(plant_count, 20)))

    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(0.95, confidence))

    notes = str(data.get("notes", "") or "")[:200] or None

    return FoodClassification(
        normalized_name=normalized,
        display_name=raw_name,
        likely_plant_foods=plants,
        plant_count_value=plant_count,
        fermented_flag=_coerce_bool(data.get("fermented")),
        omega3_flag=_coerce_bool(data.get("omega3")),
        processing_bucket=bucket,  # type: ignore[arg-type]
        confidence=confidence,
        source="ai",
        notes=notes,
        protein_source=protein,  # type: ignore[arg-type]
        probiotic_flag=_coerce_bool(data.get("probiotic")),
        seafood_flag=_coerce_bool(data.get("seafood")),
        fruit_flag=_coerce_bool(data.get("fruit")),
        vegetable_flag=_coerce_bool(data.get("vegetable")),
        alcohol_flag=_coerce_bool(data.get("alcohol")),
        processed_meat_flag=_coerce_bool(data.get("processed_meat")),
        refined_grain_flag=_coerce_bool(data.get("refined_grain")),
        omega3_source=omega3_source,  # type: ignore[arg-type]
    )


def ai_classify_food(
    raw_name: str, *, db: Any | None = None, context: str | None = None
) -> FoodClassification | None:
    """Classify a food name with the AI model. Returns a fully-populated
    FoodClassification, or None when the API key is unavailable, the call
    fails, or the response is unparseable.

    `context` is optional extra grounding (e.g. a USDA ingredient list or
    brand category) appended to the prompt. The caller persists the result.
    """
    if not raw_name:
        return None
    normalized = normalize_name(raw_name)
    if len(normalized) < 2:
        return None

    try:
        from openai import OpenAI
        from app.routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_food_enrichment,
        )
    except Exception:
        logger.warning("ai_classify_import_failed")
        return None

    api_key = get_openai_api_key()
    if not api_key:
        logger.info("ai_classify_no_key", extra={"name": normalized})
        return None

    user_content = _PROMPT + raw_name
    if context:
        user_content += f"\nAdditional context (ingredients / category): {str(context)[:600]}"

    try:
        client = OpenAI(api_key=api_key)
        kwargs = _build_chat_kwargs(
            model_food_enrichment(),
            [
                {"role": "system", "content": "You classify foods by the NOVA framework. Return JSON only."},
                {"role": "user", "content": user_content},
            ],
            max_tokens=400,
            timeout_secs=30,
        )
        resp = _chat_create(client, **kwargs)
        content = (resp.choices[0].message.content or "").strip()
        data = _extract_json(content)
    except Exception as e:
        logger.warning("ai_classify_call_failed", extra={"name": normalized, "err": str(e)[:200]})
        return None

    if not isinstance(data, dict):
        return None
    return _parse_ai_classification(data, raw_name)


# ── AI amount estimator ─────────────────────────────────────────────
#
# Per-serving amounts for nutrients USDA doesn't label. Runs once per
# unique food (cached in FoodMetadata).

_AMOUNT_PROMPT = """You are estimating per-serving amounts of nutrients that
USDA nutrition labels don't carry for a single food.

Return a JSON object with:
  "collagen_g_per_serving":
        number, grams of collagen protein per standard serving.
        Anchors (typical values, use these as reference):
          • bone broth, 1 cup            ≈ 6–12 g
          • gelatin, 1 packet (7 g)      ≈ 6 g
          • chicken with skin, 1 serving ≈ 2–4 g
          • fish with skin, 1 serving    ≈ 2–4 g
          • pork rinds, 1 oz             ≈ 4 g
          • oxtail / short ribs, serving ≈ 8–15 g
          • collagen peptide powder      ≈ label, usually 10–20 g
          • tripe / trotter / tendon     ≈ 10–20 g
        Return 0 for foods with no collagen (plant foods, skinless
        chicken breast, plain fish fillet, dairy, grains).

  "probiotic_cfu_billions_per_serving":
        number, BILLIONS of CFU (colony forming units) per standard
        serving. CFUs are the bioactive probiotic dose. Anchors:
          • plain yogurt with live cultures, 1 cup  ≈ 5–15
          • kefir, 1 cup                            ≈ 25–50
          • kombucha, 1 bottle                      ≈ 0.5–2
          • sauerkraut (raw, refrigerated), 1/2 cup ≈ 1–2
          • kimchi, 1/2 cup                         ≈ 1–10
          • natto, 1 serving                        ≈ 1–10
          • live-culture cheese, 1 oz               ≈ 0.5–1
          • probiotic supplement                    ≈ 1–100 (label)
        Cooked fermented foods lose their cultures — return 0 for
        miso soup, pasteurised sauerkraut / tempeh, sourdough bread,
        aged (non-live) cheese, yogurt-FLAVORED products.

  "prebiotic_g_per_serving":
        number, GRAMS of prebiotic (fermentable) fiber per standard
        serving. Distinct from total fiber — only fibers that feed gut
        microbes count: inulin, FOS, GOS, resistant starch, β-glucans,
        pectin. Anchors:
          • chicory root, 1 tbsp                ≈ 7
          • jerusalem artichoke, 1 cup          ≈ 14
          • garlic, 2 cloves                    ≈ 1
          • leek, 1 cup                         ≈ 4
          • onion, 1 cup raw                    ≈ 2
          • asparagus, 1 cup cooked             ≈ 3
          • slightly green banana / plantain    ≈ 4
          • oats / oatmeal, 1 cup cooked        ≈ 1.5
          • lentils / chickpeas, 1 cup cooked   ≈ 2.5
          • cooked-cooled potato/rice           ≈ 1
          • apple with skin, 1 medium           ≈ 1
        Return 0 for refined grains, animal protein, dairy without
        fermentation, juice, sugar, alcohol, processed snacks.

  "amount_confidence":
        one of "high" | "med" | "low" | "none".
          • "high": unambiguous food, known quantity (bone broth, kefir,
                    chicory root).
          • "med":  probable content, some variance (chicken with skin,
                    live-culture cheese, asparagus).
          • "low":  possible content but name is vague.
          • "none": no collagen, no probiotics, no prebiotics.

  "notes":  one short sentence explaining the amounts.

RULES:
  - Never more than 30 g collagen per serving. Clamp.
  - Never more than 200 billion CFU per serving. Clamp.
  - Never more than 25 g prebiotic fiber per serving. Clamp.
  - If the food is clearly none of: connective-tissue-based,
    LIVE-culture fermented, or rich in fermentable fiber, return zeros
    with confidence "none".
  - Respond with ONLY the JSON object. No markdown, no prose.

Food name: """


def estimate_amounts(raw_name: str) -> dict | None:
    """Returns {collagen_g_per_serving, probiotic_cfu_billions_per_serving,
    prebiotic_g_per_serving, amount_confidence} or None on failure / missing
    API key."""
    if not raw_name:
        return None
    normalized = normalize_name(raw_name)
    if len(normalized) < 2:
        return None
    try:
        from openai import OpenAI
        from app.routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_food_enrichment,
        )
    except Exception:
        return None
    api_key = get_openai_api_key()
    if not api_key:
        return None
    try:
        client = OpenAI(api_key=api_key)
        kwargs = _build_chat_kwargs(
            model_food_enrichment(),
            [
                {"role": "system", "content": "You estimate food nutrients conservatively. Return JSON only."},
                {"role": "user", "content": _AMOUNT_PROMPT + raw_name},
            ],
            max_tokens=160,
            timeout_secs=30,
        )
        resp = _chat_create(client, **kwargs)
        content = (resp.choices[0].message.content or "").strip()
        data = _extract_json(content)
    except Exception as e:
        logger.warning("ai_estimate_amounts_failed", extra={"name": normalized, "err": str(e)[:200]})
        return None
    try:
        collagen = max(0.0, min(30.0, float(data.get("collagen_g_per_serving", 0.0) or 0.0)))
    except Exception:
        collagen = 0.0
    try:
        cfu = max(0.0, min(200.0, float(data.get("probiotic_cfu_billions_per_serving", 0.0) or 0.0)))
    except Exception:
        cfu = 0.0
    try:
        prebiotic = max(0.0, min(25.0, float(data.get("prebiotic_g_per_serving", 0.0) or 0.0)))
    except Exception:
        prebiotic = 0.0
    conf = str(data.get("amount_confidence", "none")).lower()
    if conf not in ("high", "med", "low", "none"):
        conf = "none"
    return {
        "collagen_g_per_serving": collagen,
        "probiotic_cfu_billions_per_serving": cfu,
        "prebiotic_g_per_serving": prebiotic,
        "amount_confidence": conf,
    }


INSIGHT_TAGS = {
    "red_meat",
    "processed_meat",
    "seafood",
    "legume",
    "nut_seed",
    "whole_grain",
    "refined_grain",
    "sugar_sweetened_beverage",
    "high_oxalate",
    "citrus",
    "citrus_or_citrate",
    "dairy_calcium",
    "calcium_source",
    "protein_powder",
    "artificial_sweetener",
    "high_fodmap",
    "fodmap_hint",
    "fermented",
    "unsaturated_fat",
    "plant_protein",
    "potassium_proxy",
    "potassium_source",
    "caffeine",
    "caffeine_source",
    "alcohol",
}

_INSIGHT_TAG_PROMPT = """You are enriching a single food NAME for deterministic
wellness insights. Return conservative structured tags only.

Return JSON with:
  "insight_tags": array of strings chosen ONLY from:
    red_meat, processed_meat, seafood, legume, nut_seed, whole_grain,
    refined_grain, sugar_sweetened_beverage, high_oxalate, citrus,
    citrus_or_citrate, dairy_calcium, calcium_source, protein_powder,
    artificial_sweetener, high_fodmap, fodmap_hint, fermented,
    unsaturated_fat, plant_protein, potassium_proxy, potassium_source,
    caffeine, caffeine_source, alcohol
  "confidence": number 0.0-0.85
  "notes": one short sentence

Rules:
  - Prefer an empty tag list over guessing.
  - Only tag what is clearly present in the food name or a standard product
    identity. Do not infer recipe ingredients for generic foods like "salad",
    "smoothie", "bowl", "soup", "sandwich", or "snack".
  - "red_meat" means beef, pork, lamb, veal, bison, venison, goat, or mutton.
  - "processed_meat" means cured/smoked/processed meats such as bacon,
    sausage, ham, deli meat, pepperoni, salami, hot dog, jerky.
  - "dairy_calcium" means dairy or calcium-fortified foods where calcium is
    a meaningful feature.
  - "potassium_proxy" means foods commonly rich in potassium, such as beans,
    potatoes, yogurt, leafy greens, avocado, bananas.
  - "unsaturated_fat" means olive oil, avocado, nuts/seeds, fatty fish, or
    similar foods.
  - "high_fodmap" and "high_oxalate" are only food-pattern hypotheses, so tag
    only clear examples.
  - Respond with ONLY the JSON object.

Food name: """


def estimate_insight_tags(raw_name: str) -> dict | None:
    """AI enrichment for Health Insight tags. Returns None on missing key,
    failed call, or unparseable response."""
    if not raw_name:
        return None
    normalized = normalize_name(raw_name)
    if len(normalized) < 2:
        return None
    try:
        from openai import OpenAI
        from app.routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_food_enrichment,
        )
    except Exception:
        return None
    api_key = get_openai_api_key()
    if not api_key:
        return None
    try:
        client = OpenAI(api_key=api_key)
        kwargs = _build_chat_kwargs(
            model_food_enrichment(),
            [
                {"role": "system", "content": "You return conservative JSON tags for food enrichment. Prefer no tag over guessing."},
                {"role": "user", "content": _INSIGHT_TAG_PROMPT + raw_name},
            ],
            max_tokens=180,
            timeout_secs=30,
        )
        resp = _chat_create(client, **kwargs)
        data = _extract_json((resp.choices[0].message.content or "").strip())
    except Exception as e:
        logger.warning("ai_estimate_insight_tags_failed", extra={"name": normalized, "err": str(e)[:200]})
        return None
    raw_tags = data.get("insight_tags") or []
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = sorted({
        str(tag).strip().lower()
        for tag in raw_tags
        if str(tag).strip().lower() in INSIGHT_TAGS
    })
    try:
        confidence = float(data.get("confidence", 0.0))
    except Exception:
        confidence = 0.0
    confidence = max(0.0, min(0.85, confidence))
    return {
        "insight_tags": tags,
        "insight_tags_confidence": confidence,
        "insight_tags_source": "ai",
        "notes": str(data.get("notes", "") or "")[:200] or None,
    }


def insight_tags_from_metadata(meta: Any) -> set[str]:
    """Return explicit Health Insight tags already present on FoodMetadata.

    This intentionally consumes the dedicated enrichment field only. It does
    not inspect raw food names or promote legacy classifier flags into Health
    Insight evidence.
    """
    return {
        str(tag).strip().lower()
        for tag in (getattr(meta, "insight_tags", None) or [])
        if str(tag).strip().lower() in INSIGHT_TAGS
    }


# ── Persistence helpers ──────────────────────────────────────────────────────


def _valid_processing_bucket(value: Any) -> str | None:
    bucket = str(value or "").strip().lower()
    return bucket if bucket in ("minimally_processed", "processed", "ultra_processed") else None


def _apply_classification(row: Any, cls: FoodClassification) -> None:
    """Write every classification field from `cls` onto a FoodMetadata row."""
    row.normalized_name = cls.normalized_name or row.normalized_name
    row.display_name = cls.display_name or row.display_name
    row.likely_plant_foods = cls.likely_plant_foods
    row.plant_count_value = cls.plant_count_value
    row.fermented_flag = cls.fermented_flag
    row.omega3_flag = cls.omega3_flag
    row.processing_bucket = cls.processing_bucket
    row.confidence = cls.confidence
    row.source = cls.source
    row.notes = cls.notes
    row.protein_source = cls.protein_source
    row.probiotic_flag = cls.probiotic_flag
    row.seafood_flag = cls.seafood_flag
    row.fruit_flag = cls.fruit_flag
    row.vegetable_flag = cls.vegetable_flag
    row.alcohol_flag = cls.alcohol_flag
    row.processed_meat_flag = cls.processed_meat_flag
    row.refined_grain_flag = cls.refined_grain_flag


def _settle_processing_bucket(
    cls: FoodClassification, *, override: str | None, default_bucket: str | None
) -> None:
    """Resolve the final processing bucket in-place so a real food is never
    left "unknown". Authority: external override → AI grade → default."""
    if override:
        cls.processing_bucket = override  # type: ignore[assignment]
        cls.confidence = max(cls.confidence, 0.95)
        if cls.source in ("unknown", "defaulted"):
            cls.source = "external"  # type: ignore[assignment]
        cls.notes = cls.notes or "processing tier from external NOVA grade"
        return
    if cls.processing_bucket == "unknown":
        cls.processing_bucket = default_bucket or _DEFAULT_BUCKET  # type: ignore[assignment]
        if cls.source == "unknown":
            cls.source = "defaulted"  # type: ignore[assignment]
        cls.notes = cls.notes or "no AI grade available — conservative default, will reclassify"


def _insight_tags_missing(row: Any) -> bool:
    return getattr(row, "insight_tags", None) is None


def _apply_insight_tags(row: Any, tags_payload: dict | None) -> bool:
    if tags_payload is None:
        return False
    tags = set()
    source = "ai"
    confidence = 0.0
    tags.update(str(tag).strip().lower() for tag in (tags_payload.get("insight_tags") or []))
    source = str(tags_payload.get("insight_tags_source") or "ai")
    try:
        confidence = float(tags_payload.get("insight_tags_confidence", 0.0) or 0.0)
    except Exception:
        pass
    clean = sorted(tag for tag in tags if tag in INSIGHT_TAGS)
    if (
        getattr(row, "insight_tags", None) == clean
        and getattr(row, "insight_tags_source", None) == source
        and float(getattr(row, "insight_tags_confidence", 0.0) or 0.0) == confidence
    ):
        return False
    row.insight_tags = clean
    row.insight_tags_source = source
    row.insight_tags_confidence = confidence
    return True


def _apply_amounts(row: Any, amounts: dict | None) -> bool:
    if amounts is None:
        return False
    from datetime import datetime, timezone
    row.collagen_g_per_serving = amounts.get("collagen_g_per_serving")
    row.probiotic_cfu_billions_per_serving = amounts.get("probiotic_cfu_billions_per_serving")
    row.prebiotic_g_per_serving = amounts.get("prebiotic_g_per_serving")
    row.amount_confidence = amounts.get("amount_confidence") or "none"
    row.updated_at = datetime.now(timezone.utc)
    return True


def _needs_reclassification(row: Any) -> bool:
    """A v-current row still needs an AI grade if it was never AI-classified —
    i.e. it is a cold-miss default or a stale unknown."""
    return getattr(row, "source", "unknown") in ("unknown", "defaulted")


def lookup_classification(raw_name: str, db: Any) -> "FoodMetadata | None":  # type: ignore[name-defined]
    """Read-only cache lookup for the current classifier version.

    Returns the FoodMetadata row if a food has already been classified, else
    None. Never calls AI, never writes — safe for hot read paths like search
    result enrichment where triggering a classification pass would be wrong.
    """
    from sqlmodel import select
    from app.models import FoodMetadata

    normalized = normalize_name(raw_name)
    if not normalized:
        return None
    return db.exec(
        select(FoodMetadata)
        .where(FoodMetadata.normalized_name == normalized)
        .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
    ).first()


def get_or_create_metadata(
    raw_name: str,
    db: Any,
    *,
    allow_ai: bool = True,
    allow_ai_existing_enrichment: bool = False,
    require_processing_bucket: bool = False,  # kept for caller back-compat
    processing_bucket_override: str | None = None,
    default_processing_bucket: str | None = None,
    context: str | None = None,
) -> "FoodMetadata":  # type: ignore[name-defined]
    """Authoritative classification entry point — live paths + backfill.

    Lookup order:
      1. FoodMetadata cache for (normalized_name, CLASSIFIER_VERSION).
      2. AI classification (`ai_classify_food`) — the sole classifier.
      3. External NOVA override wins on the processing bucket only.
      4. AI amount + insight-tag enrichment for cold misses. Existing
         AI-graded rows are not re-enriched from live paths unless an
         explicit maintenance caller opts in.

    Never persists `processing_bucket="unknown"` for a real food. A cold miss
    we could not AI-classify is stored as a conservative default and is
    re-graded the next time `allow_ai=True` reaches it.

    Returns the FoodMetadata row. Safe + idempotent.
    """
    from datetime import datetime, timezone
    from sqlmodel import select
    from app.models import FoodMetadata

    normalized = normalize_name(raw_name)
    if not normalized:
        return FoodMetadata(
            normalized_name="", display_name=raw_name or "",
            classifier_version=CLASSIFIER_VERSION,
            likely_plant_foods=[], plant_count_value=0,
            fermented_flag=False, omega3_flag=False,
            processing_bucket="unknown", confidence=0.0, source="unknown",
            notes="empty name", protein_source="unknown", probiotic_flag=False,
            seafood_flag=False, fruit_flag=False, vegetable_flag=False,
            alcohol_flag=False, processed_meat_flag=False, refined_grain_flag=False,
        )

    bucket_override = _valid_processing_bucket(processing_bucket_override)
    default_bucket = _valid_processing_bucket(default_processing_bucket)

    existing = db.exec(
        select(FoodMetadata)
        .where(FoodMetadata.normalized_name == normalized)
        .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
    ).first()

    if existing:
        changed = False
        ai_upgraded_existing = False

        if _needs_reclassification(existing) and allow_ai:
            ai_cls = ai_classify_food(raw_name, db=db, context=context)
            if ai_cls is not None:
                _settle_processing_bucket(ai_cls, override=bucket_override, default_bucket=default_bucket)
                _apply_classification(existing, ai_cls)
                changed = True
                ai_upgraded_existing = True

        if bucket_override and getattr(existing, "processing_bucket", None) != bucket_override:
            existing.processing_bucket = bucket_override
            existing.confidence = max(float(getattr(existing, "confidence", 0.0) or 0.0), 0.95)
            if getattr(existing, "source", "unknown") in ("unknown", "defaulted"):
                existing.source = "external"
            changed = True

        can_enrich_existing = allow_ai and (ai_upgraded_existing or allow_ai_existing_enrichment)

        if _insight_tags_missing(existing):
            changed = _apply_insight_tags(
                existing, estimate_insight_tags(raw_name) if can_enrich_existing else None
            ) or changed

        if (
            getattr(existing, "collagen_g_per_serving", None) is None
            and getattr(existing, "probiotic_cfu_billions_per_serving", None) is None
            and getattr(existing, "prebiotic_g_per_serving", None) is None
        ):
            changed = _apply_amounts(
                existing, estimate_amounts(raw_name) if can_enrich_existing else None
            ) or changed

        if changed:
            existing.updated_at = datetime.now(timezone.utc)
            db.add(existing)
            try:
                db.commit()
                db.refresh(existing)
            except Exception:
                db.rollback()
        return existing

    # ── Cold miss — classify and persist ─────────────────────────────
    cls = ai_classify_food(raw_name, db=db, context=context) if allow_ai else None
    if cls is None:
        cls = empty_classification(raw_name)
    _settle_processing_bucket(cls, override=bucket_override, default_bucket=default_bucket)

    amounts = estimate_amounts(raw_name) if allow_ai else None
    insight_payload = estimate_insight_tags(raw_name) if allow_ai else None
    insight_tags = (
        sorted(tag for tag in set((insight_payload or {}).get("insight_tags") or []) if tag in INSIGHT_TAGS)
        if insight_payload is not None
        else None
    )

    row = FoodMetadata(
        normalized_name=cls.normalized_name or normalized,
        display_name=cls.display_name or raw_name,
        classifier_version=CLASSIFIER_VERSION,
        likely_plant_foods=cls.likely_plant_foods,
        plant_count_value=cls.plant_count_value,
        fermented_flag=cls.fermented_flag,
        omega3_flag=cls.omega3_flag,
        processing_bucket=cls.processing_bucket,
        confidence=cls.confidence,
        source=cls.source,
        notes=cls.notes,
        protein_source=cls.protein_source,
        probiotic_flag=cls.probiotic_flag,
        seafood_flag=cls.seafood_flag,
        fruit_flag=cls.fruit_flag,
        vegetable_flag=cls.vegetable_flag,
        alcohol_flag=cls.alcohol_flag,
        processed_meat_flag=cls.processed_meat_flag,
        refined_grain_flag=cls.refined_grain_flag,
        collagen_g_per_serving=(amounts or {}).get("collagen_g_per_serving"),
        probiotic_cfu_billions_per_serving=(amounts or {}).get("probiotic_cfu_billions_per_serving"),
        prebiotic_g_per_serving=(amounts or {}).get("prebiotic_g_per_serving"),
        amount_confidence=(amounts or {}).get("amount_confidence") or "none",
        insight_tags=insight_tags,
        insight_tags_source=(insight_payload or {}).get("insight_tags_source") or "none",
        insight_tags_confidence=(insight_payload or {}).get("insight_tags_confidence") or 0.0,
    )
    db.add(row)
    try:
        db.commit()
        db.refresh(row)
    except Exception:
        # Race: another worker inserted the same key. Re-fetch and return.
        db.rollback()
        existing = db.exec(
            select(FoodMetadata)
            .where(FoodMetadata.normalized_name == normalized)
            .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
        ).first()
        if existing:
            return existing
        raise
    return row
