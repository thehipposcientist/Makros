"""AI fallback classifier for foods the deterministic/heuristic pass couldn't
handle. Conservative by design: instructed to prefer "unknown" over guessing,
requires structured JSON, and caches results in FoodMetadata keyed by
(normalized_name, classifier_version).

Calling convention:
    from app.services.nutrition.ai_classify import ai_classify_food
    classification = ai_classify_food(raw_name, db)   # None on failure

The service never raises for missing API keys — it logs and returns None so
the caller can fall back to "unknown".
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.services.nutrition.food_classifier import (
    FoodClassification, CLASSIFIER_VERSION, normalize_name,
)

logger = logging.getLogger("app.nutrition.ai_classify")

_PROMPT = """You are classifying a single food NAME for a nutrition app.

Return a JSON object with these exact fields:
  "likely_plant_foods":   array of lowercase slugs for plant-based foods clearly
                          present in the name (e.g. ["blueberry"]). Empty list
                          if none or unclear. Do NOT expand composite items
                          like "smoothie" or "salad" unless ingredients are
                          named in the input.
  "fermented_flag":       true ONLY for clearly fermented probiotic foods like
                          yogurt, kefir, kimchi, sauerkraut, miso, tempeh,
                          kombucha, natto. False otherwise.
  "omega3_flag":          true for fatty fish (salmon, sardine, mackerel,
                          anchovy, herring, trout), flax, chia, walnuts,
                          hemp seeds, or explicit fish oil / omega-3
                          supplements. False otherwise.
  "processing_bucket":    one of "minimally_processed", "processed",
                          "ultra_processed", or "unknown". Prefer "unknown"
                          when the name is ambiguous.
  "confidence":           float 0.0 – 1.0. Your honest confidence. Stay below
                          0.6 when you're not sure. Never above 0.85.
  "notes":                short string; why you chose this. One sentence max.

RULES:
  1. If the name is vague ("lunch", "snack", "my usual") → everything false,
     bucket "unknown", confidence ≤ 0.2.
  2. Ambiguous brands ("Cliff bar", "KIND bar") → lean ultra_processed,
     confidence ≤ 0.6.
  3. Never hallucinate plant ingredients. If not explicitly named, it does
     not count.
  4. Respond with ONLY the JSON object. No markdown, no prose.

Food name: """


def ai_classify_food(raw_name: str, *, db: Any | None = None) -> FoodClassification | None:
    """Run OpenAI classification on a food name. Returns None when the API
    key is unavailable, the call fails, or the response is unparseable.

    The caller is responsible for persisting the result into FoodMetadata.
    """
    if not raw_name:
        return None
    normalized = normalize_name(raw_name)
    if len(normalized) < 2:
        return None

    try:
        from openai import OpenAI
        from app.routers.ai.utils import get_openai_api_key, model_food_enrichment
    except Exception:
        logger.warning("ai_classify_import_failed")
        return None

    api_key = get_openai_api_key()
    if not api_key:
        logger.info("ai_classify_no_key", extra={"name": normalized})
        return None

    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model_food_enrichment(),
            messages=[
                {"role": "system", "content": "You classify foods conservatively. Prefer 'unknown' over guessing."},
                {"role": "user", "content": _PROMPT + raw_name},
            ],
            temperature=0.0,
            max_tokens=250,
            response_format={"type": "json_object"},
        )
        content = (resp.choices[0].message.content or "").strip()
        data = json.loads(content)
    except Exception as e:
        logger.warning("ai_classify_call_failed", extra={"name": normalized, "err": str(e)[:200]})
        return None

    # Validate + clamp
    plants_raw = data.get("likely_plant_foods") or []
    if not isinstance(plants_raw, list):
        plants_raw = []
    plants = [str(p).lower().replace(" ", "_")[:40] for p in plants_raw if isinstance(p, str)][:20]

    bucket = str(data.get("processing_bucket", "unknown")).lower()
    if bucket not in ("minimally_processed", "processed", "ultra_processed", "unknown"):
        bucket = "unknown"

    try:
        confidence = float(data.get("confidence", 0.0))
    except Exception:
        confidence = 0.0
    confidence = max(0.0, min(0.85, confidence))  # never trust AI above 0.85

    notes = str(data.get("notes", "") or "")[:200] or None

    return FoodClassification(
        normalized_name=normalized,
        display_name=raw_name,
        likely_plant_foods=plants,
        plant_count_value=len(plants),
        fermented_flag=bool(data.get("fermented_flag", False)),
        omega3_flag=bool(data.get("omega3_flag", False)),
        processing_bucket=bucket,  # type: ignore[arg-type]
        confidence=confidence,
        source="ai",
        notes=notes,
    )


# ── AI amount estimator ─────────────────────────────────────────────
#
# The boolean classifier is keyword-driven and misses foods whose names
# don't contain known fragments (custom recipes, composite dishes).
# This estimator runs on EVERY new food metadata row and returns
# per-serving amounts for nutrients USDA doesn't label. Called once
# per unique food (cached in FoodMetadata), so scaling cost is
# "new unique foods × one cheap prompt" — essentially nothing.

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

  "amount_confidence":
        one of "high" | "med" | "low" | "none".
          • "high": unambiguous food, known quantity (bone broth, kefir).
          • "med":  probable content, some variance (chicken with skin,
                    live-culture cheese).
          • "low":  possible content but name is vague.
          • "none": no collagen and no probiotics.

  "notes":  one short sentence explaining the amounts.

RULES:
  - Never more than 30 g collagen per serving. Clamp.
  - Never more than 200 billion CFU per serving. Clamp.
  - If the food is clearly not connective-tissue-based and not a
    LIVE-culture fermented food, return zeros with confidence "none".
  - Respond with ONLY the JSON object. No markdown, no prose.

Food name: """


def estimate_amounts(raw_name: str) -> dict | None:
    """Returns {collagen_g_per_serving, probiotic_servings_per_serving,
    amount_confidence} or None on failure / missing API key."""
    if not raw_name:
        return None
    normalized = normalize_name(raw_name)
    if len(normalized) < 2:
        return None
    try:
        from openai import OpenAI
        from app.routers.ai.utils import get_openai_api_key, model_food_enrichment
    except Exception:
        return None
    api_key = get_openai_api_key()
    if not api_key:
        return None
    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model_food_enrichment(),
            messages=[
                {"role": "system", "content": "You estimate food nutrients conservatively. Return JSON only."},
                {"role": "user", "content": _AMOUNT_PROMPT + raw_name},
            ],
            temperature=0.0,
            max_tokens=160,
            response_format={"type": "json_object"},
        )
        content = (resp.choices[0].message.content or "").strip()
        data = json.loads(content)
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
    conf = str(data.get("amount_confidence", "none")).lower()
    if conf not in ("high", "med", "low", "none"):
        conf = "none"
    # When both amounts are zero we still store "none" so the UI knows
    # we *did* evaluate this food and found nothing, vs never evaluated.
    return {
        "collagen_g_per_serving": collagen,
        "probiotic_cfu_billions_per_serving": cfu,
        "amount_confidence": conf,
    }


def get_or_create_metadata(
    raw_name: str,
    db: Any,
    *,
    allow_ai: bool = True,
) -> "FoodMetadata":  # type: ignore[name-defined]
    """Main entrypoint used by the backfill + live paths.

    Lookup order:
      1. FoodMetadata cache for (normalized_name, CLASSIFIER_VERSION)
      2. deterministic + heuristic classifier
      3. AI fallback (only if allowed and the heuristic pass returned "unknown")
      4. persist result into FoodMetadata for next time

    Returns the FoodMetadata row. Safe + idempotent.
    """
    from sqlmodel import select
    from app.models import FoodMetadata
    from app.services.nutrition.food_classifier import classify_food

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

    existing = db.exec(
        select(FoodMetadata)
        .where(FoodMetadata.normalized_name == normalized)
        .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
    ).first()
    if existing:
        if (
            allow_ai
            and getattr(existing, "collagen_g_per_serving", None) is None
            and getattr(existing, "probiotic_cfu_billions_per_serving", None) is None
        ):
            amounts = estimate_amounts(raw_name)
            if amounts is not None:
                from datetime import datetime, timezone
                existing.collagen_g_per_serving = amounts.get("collagen_g_per_serving")
                existing.probiotic_cfu_billions_per_serving = amounts.get("probiotic_cfu_billions_per_serving")
                existing.amount_confidence = amounts.get("amount_confidence") or "none"
                existing.updated_at = datetime.now(timezone.utc)
                db.add(existing)
                try:
                    db.commit()
                    db.refresh(existing)
                except Exception:
                    db.rollback()
        return existing

    cls = classify_food(raw_name)

    # Only call AI when our own pass was inconclusive.
    if allow_ai and cls.source == "unknown":
        ai_cls = ai_classify_food(raw_name, db=db)
        if ai_cls is not None:
            cls = ai_cls

    # AI amount estimation runs on EVERY food regardless of what the
    # deterministic classifier found. Keyword matching misses too many
    # real-world foods — a user's "Grandma's chicken soup" wouldn't
    # match collagen keywords but still contains meaningful amounts.
    # One cached AI call per unique food, indexed by normalized name +
    # classifier_version, so scaling cost is trivial.
    amounts = None
    if allow_ai:
        amounts = estimate_amounts(raw_name)

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
        seafood_flag=getattr(cls, "seafood_flag", False),
        fruit_flag=getattr(cls, "fruit_flag", False),
        vegetable_flag=getattr(cls, "vegetable_flag", False),
        alcohol_flag=getattr(cls, "alcohol_flag", False),
        processed_meat_flag=getattr(cls, "processed_meat_flag", False),
        refined_grain_flag=getattr(cls, "refined_grain_flag", False),
        collagen_g_per_serving=(amounts or {}).get("collagen_g_per_serving"),
        probiotic_cfu_billions_per_serving=(amounts or {}).get("probiotic_cfu_billions_per_serving"),
        amount_confidence=(amounts or {}).get("amount_confidence") or "none",
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
