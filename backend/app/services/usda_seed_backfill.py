"""USDA backfill helpers for the curated seed food catalog.

The curated seed rows stay as `source=seed` so onboarding can remain small and
opinionated. This module lets us update those rows from FoodData Central while
preserving their Thallo display names, categories, aliases, and serving labels.
"""
from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx
from dotenv import load_dotenv
from sqlmodel import Session, select

from app.enums import FoodSource
from app.food_service import normalize_food_name
from app.models import Food, FoodNutrition, FoodServing
from app.seed_foods_data import SEED_FOODS
from app.seed_micronutrients_data import split_into_columns_and_extras
from app.services.usda_fdc import _BASE, _TIMEOUT, _api_key, _clean_name, _extract_nutrients


@dataclass
class USDASeedBackfillRow:
    name: str
    status: str
    fdc_id: str | None = None
    description: str | None = None
    score: float = 0
    reason: str | None = None


def _entry_query(entry: dict) -> str:
    if entry.get("usda_query"):
        raw = str(entry["usda_query"])
        return re.sub(r"[^a-zA-Z0-9 %]+", " ", raw).strip()
    parts = [str(entry["name"])]
    if entry.get("prep_state") in {"cooked", "raw", "dry", "canned"}:
        parts.append(str(entry["prep_state"]))
    return re.sub(r"[^a-zA-Z0-9 %]+", " ", " ".join(parts)).strip()


def _tokens(value: str) -> set[str]:
    out: set[str] = set()
    for token in re.sub(r"[^a-z0-9 ]", " ", value.lower()).split():
        if not token or token in {"and", "or", "with", "without", "ns", "nfs"}:
            continue
        out.add(token[:-1] if len(token) > 3 and token.endswith("s") else token)
    return out


def _candidate_score(entry: dict, candidate: dict[str, Any]) -> float:
    wanted = _tokens(str(entry["name"]))
    query_tokens = _tokens(_entry_query(entry))
    description = str(candidate.get("description") or "")
    found = _tokens(description)
    if not wanted or not found:
        return 0

    overlap = len(wanted & found) / len(wanted)
    query_overlap = len(query_tokens & found) / max(len(query_tokens), 1)
    score = overlap * 0.75 + query_overlap * 0.25

    data_type = str(candidate.get("dataType") or "")
    if data_type in {"Foundation", "SR Legacy"}:
        score += 0.08
    elif data_type == "Survey (FNDDS)":
        score += 0.04
    elif data_type == "Branded":
        score -= 0.12

    lowered = description.lower()
    for penalty in ("babyfood", "restaurant", "fast food", "school lunch"):
        if penalty in lowered:
            score -= 0.18
    if entry.get("prep_state") != "processed":
        for penalty in ("breaded", "battered", "batter", "fried", "flour", "nugget", "tender"):
            if penalty in lowered:
                score -= 0.35
    if re.search(r"\bskin\s*\(", lowered) or lowered.startswith("chicken, skin"):
        score -= 0.45
    if "from pre-cooked" in lowered:
        score -= 0.06
    if "loaf" in lowered and "loaf" not in str(entry["name"]).lower():
        score -= 0.08
    if "ground" in str(entry["name"]).lower() and ("crumbles" in lowered or "pan-browned" in lowered):
        score += 0.04
    if "meat only" in lowered or "skinless" in lowered:
        score += 0.07
    prep_state = str(entry.get("prep_state") or "")
    if prep_state and prep_state in lowered:
        score += 0.06
    return max(0, score)


def _fetch_usda_candidates(query: str, *, page_size: int = 12) -> list[dict[str, Any]]:
    key = _api_key()
    if not key:
        raise RuntimeError("USDA_FDC_API_KEY is not configured")
    resp = httpx.post(
        f"{_BASE}/foods/search",
        params={"api_key": key},
        json={
            "query": query,
            "pageSize": page_size,
            "dataType": ["Foundation", "SR Legacy", "Survey (FNDDS)"],
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    foods = resp.json().get("foods", [])
    return [food for food in foods if _extract_nutrients(food).get("calories") is not None]


def _fetch_usda_food(fdc_id: str) -> dict[str, Any] | None:
    key = _api_key()
    if not key:
        raise RuntimeError("USDA_FDC_API_KEY is not configured")
    resp = httpx.get(
        f"{_BASE}/food/{fdc_id}",
        params={"api_key": key},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    food = resp.json()
    return food if _extract_nutrients(food).get("calories") is not None else None


def _best_candidate(
    entry: dict,
    *,
    min_score: float,
    allow_search: bool,
) -> tuple[dict[str, Any] | None, float, str | None]:
    if entry.get("usda_fdc_id"):
        candidate = _fetch_usda_food(str(entry["usda_fdc_id"]))
        return candidate, 1.5 if candidate else 0, None
    if not allow_search:
        return None, 0, "skipped_unpinned"

    candidates = _fetch_usda_candidates(_entry_query(entry))
    ranked = sorted(
        ((candidate, _candidate_score(entry, candidate)) for candidate in candidates),
        key=lambda row: row[1],
        reverse=True,
    )
    if not ranked or ranked[0][1] < min_score:
        return None, ranked[0][1] if ranked else 0, "no_safe_match"
    candidate, score = ranked[0]
    return candidate, score, None


def _safe_error(exc: Exception) -> str:
    return re.sub(r"api_key=[^&\\s']+", "api_key=***", str(exc))


def _canonical_panel(nutrients: dict[str, float]) -> dict[str, float]:
    panel: dict[str, float] = {}
    key_map = {
        "fiber": "fiber",
        "sugar": "sugar",
        "sodium_mg": "sodium",
        "calcium_mg": "calcium",
        "iron_mg": "iron",
        "magnesium_mg": "magnesium",
        "phosphorus_mg": "phosphorus",
        "potassium_mg": "potassium",
        "zinc_mg": "zinc",
        "copper_mg": "copper",
        "manganese_mg": "manganese",
        "selenium_mcg": "selenium",
        "vitamin_d_mcg": "vitamin_d",
        "vitamin_b12_mcg": "vitamin_b12",
        "vitamin_c_mg": "vitamin_c",
        "vitamin_e_mg": "vitamin_e",
        "vitamin_a_mcg": "vitamin_a",
        "saturated_fat": "saturated_fat",
        "monounsaturated_fat": "monounsaturated_fat",
        "polyunsaturated_fat": "polyunsaturated_fat",
        "omega_3": "omega_3",
        "omega_6": "omega_6",
        "cholesterol_mg": "cholesterol",
    }
    for source, target in key_map.items():
        value = nutrients.get(source)
        if value is not None:
            panel[target] = value
    return panel


def _apply_candidate(db: Session, food: Food, candidate: dict[str, Any]) -> None:
    nutrients = _extract_nutrients(candidate)
    panel = _canonical_panel(nutrients)
    top_cols, extras = split_into_columns_and_extras(panel)

    food.external_id = str(candidate.get("fdcId") or "")
    food.is_verified = True
    food.calories = nutrients.get("calories", food.calories)
    food.protein = nutrients.get("protein", food.protein)
    food.carbs = nutrients.get("carbs", food.carbs)
    food.fat = nutrients.get("fat", food.fat)
    food.fiber = top_cols.get("fiber", food.fiber)
    food.sugar = top_cols.get("sugar", food.sugar)
    food.sodium_mg = top_cols.get("sodium_mg", food.sodium_mg)
    db.add(food)

    nutrition = db.exec(select(FoodNutrition).where(FoodNutrition.food_id == food.id)).first()
    if nutrition is None:
        nutrition = FoodNutrition(food_id=food.id or 0)
    nutrition.reference_unit = "100g"
    nutrition.reference_grams = 100
    nutrition.calories = nutrients.get("calories", nutrition.calories)
    nutrition.protein = nutrients.get("protein", nutrition.protein)
    nutrition.carbs = nutrients.get("carbs", nutrition.carbs)
    nutrition.fat = nutrients.get("fat", nutrition.fat)
    nutrition.fiber = top_cols.get("fiber")
    nutrition.sugar = top_cols.get("sugar")
    nutrition.added_sugar_g = nutrients.get("added_sugar_g")
    nutrition.sodium_mg = top_cols.get("sodium_mg")
    nutrition.extra_nutrients = extras or None
    db.add(nutrition)

    servings = db.exec(select(FoodServing).where(FoodServing.food_id == food.id)).all()
    for serving in servings:
        ratio = serving.grams / 100 if serving.grams else 1
        serving.calories = round(nutrition.calories * ratio, 1)
        serving.protein = round(nutrition.protein * ratio, 1)
        serving.carbs = round(nutrition.carbs * ratio, 1)
        serving.fat = round(nutrition.fat * ratio, 1)
        db.add(serving)


def backfill_seed_foods_from_usda(
    db: Session,
    *,
    names: set[str] | None = None,
    limit: int | None = None,
    min_score: float = 0.72,
    dry_run: bool = True,
    allow_search: bool = False,
) -> list[USDASeedBackfillRow]:
    entries = SEED_FOODS
    if names:
        wanted = {normalize_food_name(name) for name in names}
        entries = [entry for entry in entries if normalize_food_name(str(entry["name"])) in wanted]
    if limit is not None:
        entries = entries[:limit]

    rows: list[USDASeedBackfillRow] = []
    for entry in entries:
        name = str(entry["name"])
        food = db.exec(
            select(Food).where(
                Food.source == FoodSource.SEED,
                Food.normalized_name == normalize_food_name(name),
            )
        ).first()
        if food is None:
            rows.append(USDASeedBackfillRow(name=name, status="missing_seed_row"))
            continue
        try:
            candidate, score, miss_status = _best_candidate(
                entry,
                min_score=min_score,
                allow_search=allow_search,
            )
        except Exception as exc:
            rows.append(USDASeedBackfillRow(name=name, status="error", reason=_safe_error(exc)))
            continue
        if candidate is None:
            rows.append(USDASeedBackfillRow(name=name, status=miss_status or "no_safe_match", score=score))
            continue

        fdc_id = str(candidate.get("fdcId") or "")
        description = _clean_name(str(candidate.get("description") or ""))
        if not dry_run:
            _apply_candidate(db, food, candidate)
        rows.append(USDASeedBackfillRow(
            name=name,
            status="would_update" if dry_run else "updated",
            fdc_id=fdc_id,
            description=description,
            score=round(score, 3),
        ))

    if not dry_run:
        db.commit()
    return rows


def _main() -> int:
    parser = argparse.ArgumentParser(description="Backfill curated seed foods from USDA FoodData Central.")
    parser.add_argument("--apply", action="store_true", help="Write updates. Default is dry-run.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--min-score", type=float, default=0.72)
    parser.add_argument("--name", action="append", default=[])
    parser.add_argument(
        "--allow-search",
        action="store_true",
        help="Allow fuzzy USDA search for rows without a reviewed usda_fdc_id. Default skips unpinned rows.",
    )
    args = parser.parse_args()

    load_dotenv()
    backend_env = os.path.join(os.getcwd(), "backend", ".env")
    if os.path.exists(backend_env):
        load_dotenv(backend_env)

    from app.database import engine

    with Session(engine) as db:
        rows = backfill_seed_foods_from_usda(
            db,
            names=set(args.name) if args.name else None,
            limit=args.limit,
            min_score=args.min_score,
            dry_run=not args.apply,
            allow_search=args.allow_search,
        )
    for row in rows:
        detail = f" fdc_id={row.fdc_id} score={row.score} match={row.description}" if row.fdc_id else ""
        reason = f" reason={row.reason}" if row.reason else ""
        print(f"{row.status}: {row.name}{detail}{reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
