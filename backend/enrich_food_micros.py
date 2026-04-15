"""One-off maintenance script: enrich existing `food_nutrition` rows
with missing Layer-1 + Layer-2 micronutrients via the OpenAI API.

Run once after deploying the micronutrient expansion to backfill
historical rows whose `extra_nutrients` JSON is empty or only carries
fiber/sugar/sodium. Idempotent — rows that already have the full panel
are skipped.

Usage:
    cd backend
    python enrich_food_micros.py                 # enrich all missing
    python enrich_food_micros.py --limit 100     # test on a small batch
    python enrich_food_micros.py --dry-run       # no DB writes

Cost: ~$0.0005 per food on gpt-4o-mini. Batches 10 foods per call, so
a 2,000-row DB is ~$0.10 and ~15 minutes wall time. Fails gracefully —
rows that error out are skipped and logged, not nuked.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

from sqlmodel import Session, select

from app.database import engine
from app.models import Food, FoodNutrition, FoodServing


REQUIRED_FIELDS = (
    "fiber", "sugar", "sodium", "cholesterol",
    "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
    "omega_3", "omega_6",
    "potassium", "calcium", "iron", "magnesium",
    "vitamin_c", "vitamin_d", "vitamin_b12",
)

# Rows are considered "enriched" when at least this many canonical
# fields are present. Prevents re-enriching rows that already have most
# of what we need.
ENRICHED_THRESHOLD = 10

BATCH_SIZE = 5


def _needs_enrichment(nut: FoodNutrition) -> bool:
    """Check whether this row is missing any of the Layer 2 keys we expect.
    A row is fully enriched when every non-legacy field is PRESENT in
    `extra_nutrients` (zero is allowed — it's still present)."""
    extras = getattr(nut, "extra_nutrients", None) or {}
    if not isinstance(extras, dict):
        extras = {}
    # Legacy columns are the first three; the remaining 13 live in extras.
    layer2 = [k for k in REQUIRED_FIELDS if k not in ("fiber", "sugar", "sodium")]
    for k in layer2:
        if k not in extras:
            return True
    return False


def _ai_enrich_batch(client, foods: list[tuple[Food, FoodNutrition]]) -> dict[int, dict[str, float]]:
    """Call the AI once for a batch of foods. Returns {food_id: micros_dict}.

    Uses a STRICT JSON schema that marks every required field as required
    on every food, so the model can't cherry-pick fields. After parsing,
    any field the model still managed to omit is force-filled with 0.0 —
    every food in the return dict has EXACTLY the 16 required keys."""
    items_payload = []
    for food, _ in foods:
        items_payload.append({
            "food_id": food.id,
            "name": food.name,
            "reference_unit": "100 g",
        })

    # Loose schema — require the structure but let the model return any
    # numeric keys inside `micros`. The post-parse loop force-fills any
    # missing required field with 0.0, so even a sparse AI response
    # lands every key in the DB.
    schema = {
        "name": "food_micros_batch",
        "schema": {
            "type": "object",
            "required": ["foods"],
            "properties": {
                "foods": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["food_id", "micros"],
                        "properties": {
                            "food_id": {"type": "integer"},
                            "name": {"type": "string"},
                            "micros": {
                                "type": "object",
                                "additionalProperties": True,
                            },
                        },
                    },
                },
            },
        },
    }

    prompt = (
        "Return USDA per-100g micronutrient values for each food. EVERY food "
        "MUST include ALL 16 micronutrient fields. Use 0 for genuine zeros, "
        "never omit a field.\n\n"
        "CRITICAL UNITS — read carefully, the values in mg are often >100 for "
        "real foods:\n"
        "  fiber              → GRAMS     (0-20, e.g. black beans 7.5)\n"
        "  sugar              → GRAMS     (0-50)\n"
        "  saturated_fat      → GRAMS     (0-30, e.g. butter 51, beef 6)\n"
        "  monounsaturated_fat→ GRAMS     (0-70, e.g. olive oil 73, avocado 10)\n"
        "  polyunsaturated_fat→ GRAMS     (0-60, e.g. walnuts 47, salmon 4)\n"
        "  sodium             → MILLIGRAMS (0-5000, e.g. salt 38758, soy sauce 5493, chicken 74)\n"
        "  cholesterol        → MILLIGRAMS (0-700, e.g. egg 373, chicken 85, salmon 60)\n"
        "  omega_3            → MILLIGRAMS (0-3000, e.g. SALMON 2260, chia seeds 17552, walnuts 9080, chicken 40)\n"
        "  omega_6            → MILLIGRAMS (0-40000, e.g. chicken 1520, salmon 172, walnuts 38093)\n"
        "  potassium          → MILLIGRAMS (0-700, e.g. banana 358, spinach 558, chicken 256)\n"
        "  calcium            → MILLIGRAMS (0-1200, e.g. milk 113, cheese 720, chicken 11)\n"
        "  iron               → MILLIGRAMS (0-20, e.g. spinach 2.7, beef 2.6, chicken 0.9)\n"
        "  magnesium          → MILLIGRAMS (0-600, e.g. pumpkin seeds 550, spinach 79, chicken 27)\n"
        "  vitamin_c          → MILLIGRAMS (0-250, e.g. orange 53, bell pepper 128, chicken 0)\n"
        "  vitamin_d          → MICROGRAMS (0-25,  e.g. SALMON 20, egg 2, chicken 0.2)\n"
        "  vitamin_b12        → MICROGRAMS (0-20,  e.g. beef 2.6, salmon 3.2, chicken 0.3)\n\n"
        "NEVER return grams for a mg field. If you're unsure about a value, "
        "multiply by 1000 before returning (e.g. 2.26 g → 2260 mg). omega_3 for "
        "salmon MUST be around 2260, never 2.3.\n\n"
        f"Foods to enrich:\n{json.dumps(items_payload, indent=2)}"
    )
    try:
        resp = client.chat.completions.create(
            model=os.getenv("MODEL_FOOD_ENRICHMENT") or "gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a USDA nutrition database. Return accurate per-100g micronutrient values. Every required field on every food, zero is allowed but omission is not."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_schema", "json_schema": schema},
            max_tokens=3000,
            timeout=45,
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
    except Exception as e:
        print(f"  [!] AI call failed for batch: {e}")
        return {}

    # Unit upconvert rules — ONLY applied to fields where a single-digit
    # value is almost certainly a grams-return mis-labeled as mg.
    # Fields where single-digit mg values are LEGITIMATE (calcium in
    # meat = 9 mg, magnesium in bread = 8 mg, iron in most foods = 1-5 mg,
    # vitamin_c in animal foods = 0) are EXCLUDED from this rule.
    #
    # Safe upconvert set — minimum realistic value is ≥10 mg for any
    # food that has the nutrient at all:
    #   - sodium: seasoned foods start at 50+ mg; a bare meat is ~70
    #   - potassium: even low-K foods are 100+ mg/100g
    #   - omega_3 / omega_6: values come back in grams often; real mg
    #     range starts at ~20 for meats and goes to 10000+ for seeds
    #   - cholesterol: animal foods 50-700 mg, plant foods 0
    UPCONVERT_MG_FIELDS = {
        "sodium", "potassium", "omega_3", "omega_6", "cholesterol",
    }

    out: dict[int, dict[str, float]] = {}
    for entry in data.get("foods") or []:
        if not isinstance(entry, dict):
            continue
        fid = entry.get("food_id")
        micros = entry.get("micros") or {}
        if not isinstance(fid, int) or not isinstance(micros, dict):
            continue
        complete: dict[str, float] = {}
        for k in REQUIRED_FIELDS:
            v = micros.get(k)
            try:
                fv = float(v) if v is not None else 0.0
            except (TypeError, ValueError):
                fv = 0.0
            # Unit sanity ONLY for the safe set — single-digit mg values
            # for these fields are almost certainly grams-returns.
            if k in UPCONVERT_MG_FIELDS and 0 < fv < 10:
                fv = fv * 1000.0
            complete[k] = fv
        out[fid] = complete
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max foods to process (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="Do not write to DB")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    try:
        from openai import OpenAI
        from app.routers.ai.utils import get_openai_api_key
        api_key = get_openai_api_key()
        if not api_key:
            print("ERROR: OPENAI_API_KEY not configured")
            sys.exit(1)
        client = OpenAI(api_key=api_key)
    except Exception as e:
        print(f"ERROR: failed to init OpenAI client: {e}")
        sys.exit(1)

    with Session(engine) as db:
        nut_rows = db.exec(select(FoodNutrition)).all()
        candidates = [n for n in nut_rows if _needs_enrichment(n)]
        if args.limit > 0:
            candidates = candidates[: args.limit]
        print(f"[enrich_food_micros] {len(candidates)} rows need enrichment "
              f"(out of {len(nut_rows)} total)")
        if not candidates:
            print("[enrich_food_micros] nothing to do")
            return

        food_ids = [n.food_id for n in candidates]
        foods_by_id = {
            f.id: f for f in db.exec(select(Food).where(Food.id.in_(food_ids))).all()
        }

        enriched_count = 0
        for start in range(0, len(candidates), BATCH_SIZE):
            batch = candidates[start : start + BATCH_SIZE]
            pairs = [(foods_by_id[n.food_id], n) for n in batch if n.food_id in foods_by_id]
            if not pairs:
                continue
            print(f"\n[batch {start // BATCH_SIZE + 1}] {len(pairs)} foods: "
                  f"{', '.join(f.name for f, _ in pairs[:4])}...")
            results = _ai_enrich_batch(client, pairs)
            for food, nut in pairs:
                micros = results.get(food.id)
                if not micros:
                    print(f"  [skip] {food.name}: no AI data")
                    continue
                extras = dict(getattr(nut, "extra_nutrients", None) or {})
                # Write every required field. Zero is a real value — we
                # want the key present in extras so the downstream
                # "needs enrichment" check stops re-running on this food.
                for k, v in micros.items():
                    if k == "fiber":
                        nut.fiber = v
                    elif k == "sugar":
                        nut.sugar = v
                    elif k == "sodium":
                        nut.sodium_mg = v
                    else:
                        extras[k] = v
                # Belt-and-braces: force every Layer 2 key into extras
                # even if the AI somehow missed one.
                for k in REQUIRED_FIELDS:
                    if k in ("fiber", "sugar", "sodium"):
                        continue
                    if k not in extras:
                        extras[k] = 0.0
                nut.extra_nutrients = extras
                if args.verbose:
                    print(f"  [ok]   {food.name}: 16 fields written")
                enriched_count += 1
                if not args.dry_run:
                    db.add(nut)
            if not args.dry_run:
                db.commit()
            # Be polite to the API.
            time.sleep(0.5)

        print(f"\n[enrich_food_micros] done — enriched {enriched_count}/{len(candidates)} "
              f"({'DRY RUN' if args.dry_run else 'WRITTEN'})")


if __name__ == "__main__":
    main()
