"""Saved Meals — user-authored reusable food bundles.

Distinct from:
  • Routine meals (pinned/scheduled recurring — lives on UserProfile /
    NutritionPlan.routine_meals).
  • Recipes (ingredients + serving math + cooking instructions — later).

A SavedMeal stores a flat list of items + macro totals. Logging a saved
meal clones its items into a fresh Meal row, while keeping a nullable
saved_meal_id provenance link for audit/dedupe purposes. Later template
edits do not rewrite logged meal history.
"""
from __future__ import annotations

import copy
import secrets
from datetime import datetime, date, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import FREE_SAVED_MEAL_LIMIT, is_pro
from app.models import Meal, MealItem, SavedMeal, User
from app.enums import MealType, MealSource
from app.auth import get_current_user
from app.services.nutrition.added_sugar import resolve_added_sugar_g
from app.services.nutrition.food_image_provider import resolve_food_image


router = APIRouter(prefix="/meals/saved", tags=["meals"])

SHARE_CODE_LENGTH = 6
_SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


def _serialize(row: SavedMeal, *, owner_username: str | None = None) -> dict:
    out = row.model_dump()
    if owner_username is not None:
        out["owner_username"] = owner_username
        out["owned_by_viewer"] = False
    return out


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def _generate_share_code(db: Session) -> str:
    for attempt in range(12):
        length = SHARE_CODE_LENGTH + (1 if attempt >= 7 else 0)
        code = "".join(secrets.choice(_SHARE_CODE_ALPHABET) for _ in range(length))
        existing = db.exec(
            select(SavedMeal.id).where(SavedMeal.share_code == code)
        ).first()
        if existing is None:
            return code
    raise HTTPException(status_code=500, detail="Could not allocate share code")


def _get_owned_saved_meal(db: Session, user_id: int, saved_id: int) -> SavedMeal:
    row = db.get(SavedMeal, saved_id)
    if not row or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="Saved meal not found")
    return row


def _lookup_by_code(db: Session, code: str) -> SavedMeal:
    code_norm = _normalize_code(code)
    if not code_norm:
        raise HTTPException(status_code=400, detail="share code required")
    row = db.exec(
        select(SavedMeal).where(SavedMeal.share_code == code_norm)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Saved meal not found for that code")
    return row


def _enforce_saved_meal_cap(db: Session, user: User, *, importing: bool = False) -> None:
    if is_pro(user) or FREE_SAVED_MEAL_LIMIT is None:
        return
    existing_count = len(db.exec(
        select(SavedMeal).where(SavedMeal.user_id == user.id)
    ).all())
    if existing_count < FREE_SAVED_MEAL_LIMIT:
        return
    detail = f"Free accounts can save up to {FREE_SAVED_MEAL_LIMIT} meals."
    if importing:
        detail = (
            f"You're at the {FREE_SAVED_MEAL_LIMIT}-meal limit. "
            "Delete one before importing this meal, or upgrade to Pro."
        )
    raise HTTPException(status_code=403, detail=detail)


def _totals_from_items(items: list[dict]) -> tuple[float, float, float, float]:
    cal = sum(float(i.get("calories") or 0) for i in items)
    p = sum(float(i.get("protein_g") or 0) for i in items)
    c = sum(float(i.get("carbs_g") or 0) for i in items)
    f = sum(float(i.get("fat_g") or 0) for i in items)
    return round(cal, 1), round(p, 1), round(c, 1), round(f, 1)


_SAVED_ITEM_NUTRIENT_SOURCES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("saturated_fat_g", "saturated_fat", ("saturated_fat_g", "saturated_fat")),
    ("cholesterol_mg", "cholesterol", ("cholesterol_mg", "cholesterol")),
    ("sodium_mg", "sodium", ("sodium_mg", "sodium")),
    ("fiber_g", "fiber", ("fiber_g", "fiber")),
    ("sugar_g", "sugar", ("sugar_g", "sugar")),
    ("added_sugar_g", "added_sugar", ("added_sugar_g", "added_sugar")),
    ("caffeine_mg", "caffeine", ("caffeine_mg", "caffeine")),
    ("potassium_mg", "potassium", ("potassium_mg", "potassium")),
    ("calcium_mg", "calcium", ("calcium_mg", "calcium")),
    ("magnesium_mg", "magnesium", ("magnesium_mg", "magnesium")),
    ("iron_mg", "iron", ("iron_mg", "iron")),
    ("vitamin_d_mcg", "vitamin_d", ("vitamin_d_mcg", "vitamin_d")),
    ("vitamin_b12_mcg", "vitamin_b12", ("vitamin_b12_mcg", "vitamin_b12")),
    ("folate_mcg", "folate", ("folate_mcg", "folate", "folate_b9")),
    ("zinc_mg", "zinc", ("zinc_mg", "zinc")),
    ("omega_3_g", "omega_3", ("omega_3_g", "omega_3")),
)


def _float_or_none(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _saved_item_nutrient_value(item: dict, field: str, micro_keys: tuple[str, ...]) -> float | None:
    value = _float_or_none(item.get(field))
    if value is not None:
        return value
    micros = item.get("micronutrients") if isinstance(item.get("micronutrients"), dict) else {}
    for key in micro_keys:
        value = _float_or_none(micros.get(key))
        if value is not None:
            return value
    return None


def _saved_item_micronutrients(item: dict) -> dict[str, float]:
    raw = item.get("micronutrients") if isinstance(item.get("micronutrients"), dict) else {}
    micros: dict[str, float] = {}
    for key, value in raw.items():
        parsed = _float_or_none(value)
        if parsed is not None:
            micros[str(key)] = parsed
    for field, canonical, aliases in _SAVED_ITEM_NUTRIENT_SOURCES:
        value = _saved_item_nutrient_value(item, field, aliases)
        if value is not None:
            micros[canonical] = value
    return micros


def _saved_item_snapshot_kwargs(item: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for field, _canonical, aliases in _SAVED_ITEM_NUTRIENT_SOURCES:
        value = _saved_item_nutrient_value(item, field, aliases)
        if value is not None:
            out[field] = value
    sugar_g = out.get("sugar_g")
    added_sugar = resolve_added_sugar_g(
        item.get("food_name") or item.get("name"),
        reported_added_sugar_g=out.get("added_sugar_g"),
        sugar_g=sugar_g,
        serving_grams=item.get("serving_grams"),
    )
    if added_sugar is not None:
        out["added_sugar_g"] = added_sugar
    return out


def _clean_saved_item(raw: dict) -> dict:
    item = {
        "food_name": str(raw.get("food_name") or raw.get("name") or "").strip() or "Item",
        "food_id": raw.get("food_id"),
        "serving_id": raw.get("serving_id"),
        "quantity": float(raw.get("quantity") or 1),
        "unit": str(raw.get("unit") or "serving"),
        "serving_grams": raw.get("serving_grams"),
        "calories": float(raw.get("calories") or 0),
        "protein_g": float(raw.get("protein_g") or 0),
        "carbs_g": float(raw.get("carbs_g") or 0),
        "fat_g": float(raw.get("fat_g") or 0),
    }
    item.update(_saved_item_snapshot_kwargs(raw))
    micros = _saved_item_micronutrients(item | {"micronutrients": raw.get("micronutrients")})
    if micros:
        item["micronutrients"] = micros
    return item


def _saved_item_from_meal_item(item: MealItem) -> dict:
    raw = {
        "food_name": item.food_name,
        "food_id": item.food_id,
        "serving_id": item.serving_id,
        "quantity": item.quantity,
        "unit": item.unit,
        "serving_grams": item.serving_grams,
        "calories": item.calories,
        "protein_g": item.protein_g,
        "carbs_g": item.carbs_g,
        "fat_g": item.fat_g,
    }
    for field, _canonical, _aliases in _SAVED_ITEM_NUTRIENT_SOURCES:
        value = getattr(item, field, None)
        if value is not None:
            raw[field] = value
    return _clean_saved_item(raw)


def _saved_items_signature(items: list[dict]) -> str:
    from app.services.nutrition.meal_history import _normalized_item_signature

    return _normalized_item_signature([
        {
            "name": it.get("food_name") or it.get("name") or "",
            "quantity": it.get("quantity") or 0,
            "unit": it.get("unit") or "",
            "calories": it.get("calories") or 0,
            "protein": it.get("protein_g") or it.get("protein") or 0,
            "carbs": it.get("carbs_g") or it.get("carbs") or 0,
            "fat": it.get("fat_g") or it.get("fat") or 0,
        }
        for it in (items or [])
    ])


def _meal_items_signature(items: list[MealItem]) -> str:
    from app.services.nutrition.meal_history import _normalized_item_signature

    return _normalized_item_signature([
        {
            "name": item.food_name,
            "quantity": item.quantity,
            "unit": item.unit,
            "calories": item.calories,
            "protein": item.protein_g,
            "carbs": item.carbs_g,
            "fat": item.fat_g,
        }
        for item in (items or [])
    ])


def _propagate_saved_meal_name(
    *,
    db: Session,
    user_id: int,
    saved_id: int,
    old_name: str,
    old_items: list[dict],
    new_name: str,
) -> int:
    if not new_name or new_name == old_name:
        return 0

    linked = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(Meal.saved_meal_id == saved_id)
    ).all()
    legacy_named = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(Meal.name == old_name)
    ).all() if old_name else []

    candidates: dict[int, Meal] = {}
    for meal in [*linked, *legacy_named]:
        if meal.id is not None:
            candidates[meal.id] = meal
    if not candidates:
        return 0

    candidate_ids = list(candidates.keys())
    raw_items = db.exec(
        select(MealItem).where(MealItem.meal_id.in_(candidate_ids))
    ).all()
    items_by_meal: dict[int, list[MealItem]] = {}
    for item in raw_items:
        items_by_meal.setdefault(item.meal_id, []).append(item)

    saved_signature = _saved_items_signature(old_items)
    updated = 0
    for meal in candidates.values():
        is_linked = meal.saved_meal_id == saved_id
        is_legacy_match = (
            bool(saved_signature)
            and meal.name == old_name
            and _meal_items_signature(items_by_meal.get(meal.id or 0, [])) == saved_signature
        )
        if not is_linked and not is_legacy_match:
            continue
        meal.name = new_name
        meal.saved_meal_id = saved_id
        db.add(meal)
        updated += 1
    return updated


@router.get("")
def list_saved_meals(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(SavedMeal)
        .where(SavedMeal.user_id == current_user.id)
        .order_by(SavedMeal.times_logged.desc(), SavedMeal.created_at.desc())
    ).all()
    return [_serialize(r) for r in rows]


@router.post("", status_code=201)
def create_saved_meal(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Create a Saved Meal. Expected body:
        { name, notes?, items: [{food_name, food_id?, serving_id?,
          quantity, unit, serving_grams?, calories, protein_g, carbs_g, fat_g}, ...] }
    Can also create from an existing meal_id: {from_meal_id, name?}"""
    items: list[dict] = []
    name: str | None = body.get("name")
    source_meal: Meal | None = None

    from_meal_id = body.get("from_meal_id")
    if from_meal_id:
        meal = db.get(Meal, from_meal_id)
        if not meal or meal.user_id != current_user.id:
            raise HTTPException(status_code=404, detail="Source meal not found")
        existing = db.exec(
            select(SavedMeal)
            .where(SavedMeal.user_id == current_user.id)
            .where(SavedMeal.source_meal_id == meal.id)
        ).first()
        if existing is not None:
            if meal.saved_meal_id != existing.id:
                meal.saved_meal_id = existing.id
                meal.updated_at = datetime.now(timezone.utc)
                meal.version = int(getattr(meal, "version", 1) or 1) + 1
                db.add(meal)
                db.commit()
                db.refresh(existing)
            return _serialize(existing)
        source_meal = meal
        if not name:
            name = meal.name
        meal_items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
        items = [_saved_item_from_meal_item(mi) for mi in meal_items]
    else:
        raw_items = body.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            raise HTTPException(status_code=422, detail="items is required when from_meal_id not provided")
        for it in raw_items:
            if not isinstance(it, dict):
                continue
            items.append(_clean_saved_item(it))

    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if not items:
        raise HTTPException(status_code=422, detail="at least one item is required")

    # Idempotency-key fast path: a retried POST carrying the same client
    # token must return the previously-created row instead of creating a
    # duplicate. Lookup happens BEFORE the cap check + image resolution so
    # a retry is also cheap (no AI call to re-pick a thumbnail).
    idem_key = (str(body.get("idempotency_key") or "")).strip() or None
    if idem_key:
        existing = db.exec(
            select(SavedMeal)
            .where(SavedMeal.user_id == current_user.id)
            .where(SavedMeal.idempotency_key == idem_key)
        ).first()
        if existing is not None:
            return _serialize(existing)

    _enforce_saved_meal_cap(db, current_user)

    cal, p, c, f = _totals_from_items(items)
    image_url = body.get("image_url") or None
    image_source = body.get("image_source") or None
    if body.get("resolve_image") and image_source != "user_photo":
        resolved_url, resolved_source, _confidence = resolve_food_image(name, items=items)
        if resolved_url and resolved_source:
            image_url = resolved_url
            image_source = resolved_source
    row = SavedMeal(
        user_id=current_user.id, name=name, notes=body.get("notes"),
        source_meal_id=(source_meal.id if source_meal is not None else None),
        total_calories=cal, total_protein_g=p, total_carbs_g=c, total_fat_g=f,
        items=items,
        image_url=image_url,
        image_source=image_source,
        idempotency_key=idem_key,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        # Two unique indexes can fire here: (user_id, source_meal_id) when
        # favoriting the same logged meal twice, and (user_id,
        # idempotency_key) when a retry races us. Recover from either by
        # returning the existing winner — never raise to the client.
        db.rollback()
        if idem_key:
            existing = db.exec(
                select(SavedMeal)
                .where(SavedMeal.user_id == current_user.id)
                .where(SavedMeal.idempotency_key == idem_key)
            ).first()
            if existing is not None:
                return _serialize(existing)
        if source_meal is not None:
            existing = db.exec(
                select(SavedMeal)
                .where(SavedMeal.user_id == current_user.id)
                .where(SavedMeal.source_meal_id == source_meal.id)
            ).first()
            if existing is not None:
                source_meal = db.get(Meal, from_meal_id)
                if source_meal and source_meal.user_id == current_user.id:
                    source_meal.saved_meal_id = existing.id
                    source_meal.updated_at = datetime.now(timezone.utc)
                    source_meal.version = int(getattr(source_meal, "version", 1) or 1) + 1
                    db.add(source_meal)
                    db.commit()
                    db.refresh(existing)
                return _serialize(existing)
        raise
    if source_meal is not None:
        source_meal.saved_meal_id = row.id
        source_meal.updated_at = datetime.now(timezone.utc)
        source_meal.version = int(getattr(source_meal, "version", 1) or 1) + 1
        db.add(source_meal)
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.patch("/{saved_id}")
def update_saved_meal(
    saved_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Edit the template. Past logged meals stay frozen."""
    row = db.get(SavedMeal, saved_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved meal not found")
    if "name" in body and body["name"]:
        next_name = str(body["name"]).strip()
        if next_name:
            row.name = next_name
    if "notes" in body:
        row.notes = body["notes"]
    if "image_url" in body:
        row.image_url = body["image_url"] or None
    if "image_source" in body:
        row.image_source = body["image_source"] or None
    if "items" in body and isinstance(body["items"], list):
        cleaned: list[dict] = []
        for it in body["items"]:
            if not isinstance(it, dict):
                continue
            cleaned.append(_clean_saved_item(it))
        if not cleaned:
            raise HTTPException(status_code=422, detail="At least one item is required")
        row.items = cleaned
        cal, p, c, f = _totals_from_items(cleaned)
        row.total_calories = cal
        row.total_protein_g = p
        row.total_carbs_g = c
        row.total_fat_g = f
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.delete("/{saved_id}", status_code=204)
def delete_saved_meal(
    saved_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_saved_meal(db, current_user.id, saved_id)
    linked_logs = db.exec(
        select(Meal)
        .where(Meal.user_id == current_user.id)
        .where(Meal.saved_meal_id == saved_id)
    ).all()
    for meal in linked_logs:
        meal.saved_meal_id = None
        db.add(meal)
    if linked_logs:
        db.flush()
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/{saved_id}/share")
def share_saved_meal(
    saved_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_saved_meal(db, current_user.id, saved_id)
    if not row.share_code:
        row.share_code = _generate_share_code(db)
        db.add(row)
        db.commit()
        db.refresh(row)
    return {"shareCode": row.share_code, "savedMeal": _serialize(row)}


@router.delete("/{saved_id}/share", status_code=204)
def revoke_saved_meal_share(
    saved_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_owned_saved_meal(db, current_user.id, saved_id)
    if row.share_code:
        row.share_code = None
        db.add(row)
        db.commit()
    return None


@router.get("/shared/{code}")
def preview_shared_saved_meal(
    code: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _lookup_by_code(db, code)
    owner = db.get(User, row.user_id)
    out = _serialize(row, owner_username=(owner.username if owner else None))
    out["owned_by_viewer"] = row.user_id == current_user.id
    return out


@router.post("/shared/{code}/import", status_code=201)
def import_shared_saved_meal(
    code: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    source = _lookup_by_code(db, code)
    code_norm = _normalize_code(code)
    if source.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You already own this saved meal")

    existing = db.exec(
        select(SavedMeal)
        .where(SavedMeal.user_id == current_user.id)
        .where(SavedMeal.source_share_code == code_norm)
    ).first()
    if existing is not None:
        return _serialize(existing)

    _enforce_saved_meal_cap(db, current_user, importing=True)

    owner = db.get(User, source.user_id)
    row = SavedMeal(
        user_id=current_user.id,
        name=source.name,
        notes=source.notes,
        total_calories=source.total_calories,
        total_protein_g=source.total_protein_g,
        total_carbs_g=source.total_carbs_g,
        total_fat_g=source.total_fat_g,
        items=copy.deepcopy(source.items or []),
        image_url=source.image_url,
        image_source=source.image_source,
        share_code=None,
        times_imported=0,
        source_share_code=code_norm,
        source_owner_username=owner.username if owner else None,
    )
    db.add(row)
    source.times_imported = (source.times_imported or 0) + 1
    db.add(source)
    db.commit()
    db.refresh(row)
    return _serialize(row)


@router.post("/{saved_id}/log", status_code=201)
def log_saved_meal(
    saved_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Log a saved meal as a fresh Meal row on `meal_date` / `meal_type`
    provided in the body (default today / snack). Clones items so macro
    history is independent of future item edits, but links the row for
    favorite-name propagation."""
    saved = db.get(SavedMeal, saved_id)
    if not saved or saved.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved meal not found")

    meal_date_str = body.get("meal_date")
    target_date = date.fromisoformat(meal_date_str) if meal_date_str else date.today()
    mt_str = (body.get("meal_type") or "snack").lower()
    try:
        mt = MealType(mt_str)
    except ValueError:
        mt = MealType.SNACK

    consumed_at = datetime.now(timezone.utc)
    if body.get("consumed_at"):
        try:
            consumed_at = datetime.fromisoformat(str(body["consumed_at"]).replace("Z", "+00:00"))
        except ValueError:
            pass

    # Strong idempotency: a client-supplied key collapses retried / double-
    # tapped "log favorite" calls to a single row (independent of the looser
    # 120-second signature window below, which only guards accidental repeats).
    idem_key = (str(body.get("idempotency_key") or "")).strip() or None
    if idem_key:
        prior = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.idempotency_key == idem_key)
        ).first()
        if prior is not None:
            return {"meal_id": prior.id, "saved_meal_id": saved.id, "times_logged": saved.times_logged}

    # Idempotency for retries / repeated taps. A user can intentionally
    # log the same saved meal more than once, so only collapse exact item
    # matches that land in the same date/type slot within a short window.
    try:
        from app.services.nutrition.meal_history import _normalized_item_signature

        def _signature_from_saved_items(items: list[dict]) -> str:
            return _normalized_item_signature([
                {
                    "name": it.get("food_name") or it.get("name") or "",
                    "quantity": it.get("quantity") or 0,
                    "unit": it.get("unit") or "",
                    "calories": it.get("calories") or 0,
                    "protein": it.get("protein_g") or it.get("protein") or 0,
                    "carbs": it.get("carbs_g") or it.get("carbs") or 0,
                    "fat": it.get("fat_g") or it.get("fat") or 0,
                }
                for it in (items or [])
            ])

        def _ts(raw: datetime | None) -> float | None:
            if raw is None:
                return None
            if raw.tzinfo is None:
                raw = raw.replace(tzinfo=timezone.utc)
            return float(raw.timestamp())

        incoming_signature = _signature_from_saved_items(saved.items or [])
        target_ts = _ts(consumed_at)
        existing_meals = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.meal_date == target_date)
            .where(Meal.meal_type == mt)
            .where(Meal.source == MealSource.LOGGED)
            .where(Meal.name == saved.name)
            .order_by(Meal.created_at.desc())
            .limit(20)
        ).all()
        if existing_meals and incoming_signature:
            existing_items = db.exec(
                select(MealItem).where(MealItem.meal_id.in_([m.id for m in existing_meals]))
            ).all()
            items_by_meal: dict[int, list[MealItem]] = {}
            for item in existing_items:
                items_by_meal.setdefault(item.meal_id, []).append(item)
            for existing in existing_meals:
                existing_signature = _normalized_item_signature([
                    {
                        "name": item.food_name,
                        "quantity": item.quantity,
                        "unit": item.unit,
                        "calories": item.calories,
                        "protein": item.protein_g,
                        "carbs": item.carbs_g,
                        "fat": item.fat_g,
                    }
                    for item in items_by_meal.get(existing.id, [])
                ])
                existing_ts = _ts(existing.consumed_at or existing.created_at)
                if (
                    existing_signature == incoming_signature
                    and target_ts is not None
                    and existing_ts is not None
                    and abs(target_ts - existing_ts) <= 120
                ):
                    if existing.saved_meal_id != saved.id:
                        existing.saved_meal_id = saved.id
                        db.add(existing)
                        db.commit()
                    return {"meal_id": existing.id, "saved_meal_id": saved.id, "times_logged": saved.times_logged}
    except Exception:
        pass

    meal = Meal(
        user_id=current_user.id, meal_date=target_date,
        meal_type=mt, name=saved.name,
        source=MealSource.LOGGED, notes=saved.notes,
        consumed_at=consumed_at,
        image_url=saved.image_url,
        image_source=saved.image_source,
        saved_meal_id=saved.id,
        client_meal_key=mt_str[:64] if mt_str else None,
        source_type="favorite",
        idempotency_key=idem_key,
    )
    db.add(meal)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        if idem_key:
            prior = db.exec(
                select(Meal)
                .where(Meal.user_id == current_user.id)
                .where(Meal.idempotency_key == idem_key)
            ).first()
            if prior is not None:
                return {"meal_id": prior.id, "saved_meal_id": saved.id, "times_logged": saved.times_logged}
        raise

    # Backfill food_id at log time for any saved item that doesn't
    # carry one (older saves, items the user created by hand). Missing
    # food_id breaks the gut-health pipeline — fiber / sodium /
    # saturated fat / extras all come from FoodNutrition, joined by
    # food_id. Match by exact lowercase name against the Food table.
    from app.models import Food
    needed_names = {
        (it.get("food_name") or "").lower().strip()
        for it in (saved.items or [])
        if not it.get("food_id") and (it.get("food_name") or "").strip()
    }
    food_by_name: dict[str, int] = {}
    if needed_names:
        # Tolerant matcher: normalize both sides by lowercasing +
        # replacing non-alphanumerics with spaces + collapsing
        # whitespace. Matches "Spinach (Raw)" → "spinach raw" etc.
        import re as _re
        def _norm(s: str) -> str:
            return _re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
        # Load all foods matching ANY of the normalized variants.
        normalized_targets = {_norm(n) for n in needed_names}
        if normalized_targets:
            rows = db.exec(select(Food)).all()
            for f in rows:
                key = _norm(f.name or "")
                if key and key in normalized_targets and key not in food_by_name:
                    food_by_name[key] = f.id

    def _upsert_food_from_saved_item(it: dict) -> tuple[int | None, float | None]:
        micros = it.get("micronutrients") if isinstance(it.get("micronutrients"), dict) else None
        if not micros:
            return (None, None)
        name = str(it.get("food_name") or it.get("name") or "").strip()
        if not name:
            return (None, None)
        from app.models import Food, FoodNutrition, FoodServing
        from app.enums import FoodCategory, FoodSource
        from app.services.nutrition.food_classifier import normalize_name
        from app.services.nutrition.ai_classify import get_or_create_metadata

        def _grams() -> float:
            try:
                if it.get("serving_grams") is not None and float(it.get("serving_grams")) > 0:
                    return float(it.get("serving_grams"))
            except Exception:
                pass
            qty = float(it.get("quantity") or 1)
            unit = str(it.get("unit") or "").lower().strip()
            weights = {
                "g": 1.0, "gram": 1.0, "grams": 1.0,
                "kg": 1000.0, "oz": 28.35, "lb": 453.59, "lbs": 453.59,
                "ml": 1.0, "l": 1000.0, "cup": 240.0, "tbsp": 15.0,
                "tsp": 5.0, "piece": 50.0, "slice": 30.0, "scoop": 30.0,
            }
            return max(1.0, qty * weights.get(unit, 100.0))

        normalized = normalize_name(name)
        food = db.exec(
            select(Food)
            .where(Food.normalized_name == normalized)
            .where(Food.owner_user_id == current_user.id)
            .where(Food.is_active == True)  # noqa: E712
        ).first()
        grams = _grams()
        unit_label = f"{it.get('quantity') or 1} {it.get('unit') or 'serving'}"
        if food is None:
            cls = get_or_create_metadata(name, db=db, allow_ai=True)
            category = (
                FoodCategory.FRUITS if getattr(cls, "fruit_flag", False)
                else FoodCategory.VEGETABLES if getattr(cls, "vegetable_flag", False)
                else FoodCategory.PLANT_PROTEINS if cls.protein_source == "plant"
                else FoodCategory.PROTEINS if cls.protein_source == "animal"
                else FoodCategory.GRAINS_CARBS
            )
            food = Food(
                name=name,
                normalized_name=normalized,
                category=category,
                source=FoodSource.AI,
                owner_user_id=current_user.id,
                is_custom=True,
                unit=unit_label,
                serving_grams=grams,
                calories=float(it.get("calories") or 0),
                protein=float(it.get("protein_g") or 0),
                carbs=float(it.get("carbs_g") or 0),
                fat=float(it.get("fat_g") or 0),
            )
            db.add(food)
            db.flush()
        nutrition = db.exec(select(FoodNutrition).where(FoodNutrition.food_id == food.id)).first()
        if nutrition is None:
            nutrition = FoodNutrition(food_id=food.id)
        extras = dict(nutrition.extra_nutrients or {})
        sugar_value: float | None = None
        added_sugar_value: float | None = None
        for k, raw_v in micros.items():
            try:
                v = float(raw_v or 0)
            except (TypeError, ValueError):
                continue
            if k == "fiber":
                nutrition.fiber = v
            elif k == "sugar":
                nutrition.sugar = v
                sugar_value = v
            elif k in ("sodium", "sodium_mg"):
                nutrition.sodium_mg = v
            elif k in ("added_sugar", "added_sugar_g"):
                added_sugar_value = v
            else:
                extras[k] = v
        nutrition.added_sugar_g = resolve_added_sugar_g(
            name,
            reported_added_sugar_g=added_sugar_value,
            sugar_g=sugar_value,
            serving_grams=grams,
        )
        nutrition.reference_unit = unit_label
        nutrition.reference_grams = grams
        nutrition.calories = float(it.get("calories") or 0)
        nutrition.protein = float(it.get("protein_g") or 0)
        nutrition.carbs = float(it.get("carbs_g") or 0)
        nutrition.fat = float(it.get("fat_g") or 0)
        nutrition.extra_nutrients = extras
        db.add(nutrition)
        serving = db.exec(
            select(FoodServing)
            .where(FoodServing.food_id == food.id)
            .where(FoodServing.label == unit_label)
        ).first()
        if serving is None:
            serving = FoodServing(food_id=food.id, label=unit_label, grams=grams, is_default=True)
        serving.calories = nutrition.calories
        serving.protein = nutrition.protein
        serving.carbs = nutrition.carbs
        serving.fat = nutrition.fat
        db.add(serving)
        return (food.id, grams)

    for it in saved.items or []:
        fid = it.get("food_id")
        if not fid:
            # Use the same tolerant normalizer as the loader above.
            import re as _re2
            key = _re2.sub(r"[^a-z0-9]+", " ", (it.get("food_name") or "").lower()).strip()
            fid = food_by_name.get(key)
        serving_grams = it.get("serving_grams")
        if not fid:
            fid, serving_grams = _upsert_food_from_saved_item(it)
        db.add(MealItem(
            meal_id=meal.id,
            food_name=it.get("food_name") or "Item",
            food_id=fid,
            serving_id=it.get("serving_id"),
            quantity=float(it.get("quantity") or 1),
            unit=str(it.get("unit") or "serving"),
            serving_grams=serving_grams,
            calories=float(it.get("calories") or 0),
            protein_g=float(it.get("protein_g") or 0),
            carbs_g=float(it.get("carbs_g") or 0),
            fat_g=float(it.get("fat_g") or 0),
            **_saved_item_snapshot_kwargs(it),
        ))

    saved.times_logged = (saved.times_logged or 0) + 1
    saved.last_logged_at = datetime.now(timezone.utc)
    db.add(saved)
    try:
        db.commit()
    except IntegrityError:
        # Lost a race on the (user_id, idempotency_key) unique index.
        db.rollback()
        if idem_key:
            prior = db.exec(
                select(Meal)
                .where(Meal.user_id == current_user.id)
                .where(Meal.idempotency_key == idem_key)
            ).first()
            if prior is not None:
                return {"meal_id": prior.id, "saved_meal_id": saved.id, "times_logged": saved.times_logged}
        raise
    db.refresh(meal)

    # Refresh daily metrics so the new meal contributes immediately.
    try:
        from app.routers.meals import _refresh_daily_metrics  # noqa
        _refresh_daily_metrics(db, current_user.id, meal.meal_date)
    except Exception:
        pass
    return {"meal_id": meal.id, "saved_meal_id": saved.id, "times_logged": saved.times_logged}
