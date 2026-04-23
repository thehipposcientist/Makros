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
        # Return an in-memory unknown without caching empty keys.
        return FoodMetadata(
            normalized_name="", display_name=raw_name or "",
            classifier_version=CLASSIFIER_VERSION,
            likely_plant_foods=[], plant_count_value=0,
            fermented_flag=False, omega3_flag=False,
            processing_bucket="unknown", confidence=0.0, source="unknown",
            notes="empty name",
        )

    existing = db.exec(
        select(FoodMetadata)
        .where(FoodMetadata.normalized_name == normalized)
        .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
    ).first()
    if existing:
        return existing

    cls = classify_food(raw_name)

    # Only call AI when our own pass was inconclusive.
    if allow_ai and cls.source == "unknown":
        ai_cls = ai_classify_food(raw_name, db=db)
        if ai_cls is not None:
            cls = ai_cls

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
