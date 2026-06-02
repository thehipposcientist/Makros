"""Supplement Stack V1 — manual-entry stack with seeded ingredient
metadata (evidence/risk tiers). Recommendations connect to food-side
gaps (low omega-3, low vitamin D, late caffeine, etc.) so the
supplement screen doesn't live in isolation.
"""
from __future__ import annotations

import re
from datetime import datetime, date, timezone, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.database import get_session, _seed_supplement_ingredients
from app.entitlements import require_pro_feature
from app.models import (
    SupplementIngredient, UserSupplementStack, SupplementLog, User,
)
from app.auth import get_current_user


router = APIRouter(prefix="/supplements", tags=["supplements"])

DETAIL_FIELDS = ("common_uses", "deficiency_risks", "excess_risks", "food_sources")


def _normalize_supplement_name(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _apply_detail_response_fallback(data: dict, ingredient: SupplementIngredient | None) -> dict:
    from app.services.supplement_details import clean_detail_list, infer_detail_slug, supplement_detail_metadata
    from app.services.supplement_usage import item_usage_guidance
    slug = ingredient.slug if ingredient else infer_detail_slug(
        data.get("custom_name"),
        data.get("ingredient_name"),
        data.get("name"),
        data.get("category"),
    )
    guidance = item_usage_guidance(data, ingredient)
    if guidance:
        data["usage_guidance"] = guidance
    if not slug:
        return data
    details = supplement_detail_metadata(slug)
    for field in DETAIL_FIELDS:
        if data.get(field):
            continue
        value = (clean_detail_list(getattr(ingredient, field, None)) if ingredient else None) or details.get(field)
        if value:
            data[field] = value
    return data


def _coerce_nutrient_content(body: dict):
    """Build a clean nutrient_content blob from a request body. Accepts
    either a full `nutrient_content` blob or a raw `nutrient_facts` list
    (+ optional `serving_size`) — re-sanitized either way."""
    raw = body.get("nutrient_content")
    facts = body.get("nutrient_facts")
    serving = body.get("serving_size")
    if isinstance(raw, dict):
        if facts is None:
            facts = raw.get("nutrients")
        if serving is None:
            serving = raw.get("serving_size")
    if facts is None:
        return None
    from app.services.nutrition.supplement_facts import sanitize_nutrient_facts
    return sanitize_nutrient_facts(facts, serving)


# ─── Ingredient catalog ──────────────────────────────────────────────────────

@router.get("/ingredients")
def list_ingredients(
    db: Session = Depends(get_session),
):
    """Read-only catalog of seeded ingredients with evidence + risk tiers.
    Client renders these in the "Add supplement" picker."""
    _seed_supplement_ingredients()
    rows = db.exec(select(SupplementIngredient).order_by(SupplementIngredient.name)).all()
    return [_apply_detail_response_fallback(r.model_dump(), r) for r in rows]


# ─── Stack CRUD ──────────────────────────────────────────────────────────────

@router.get("/stack")
def list_stack(
    include_inactive: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    q = select(UserSupplementStack).where(UserSupplementStack.user_id == current_user.id)
    if not include_inactive:
        q = q.where(UserSupplementStack.active == True)  # noqa: E712
    rows = db.exec(q.order_by(UserSupplementStack.created_at.desc())).all()
    ingredient_ids = [r.supplement_ingredient_id for r in rows if r.supplement_ingredient_id]
    ingredients: dict[int, SupplementIngredient] = {}
    if ingredient_ids:
        found = db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ingredient_ids))).all()
        ingredients = {int(i.id): i for i in found if i.id is not None}
    out = []
    for r in rows:
        ing = ingredients.get(r.supplement_ingredient_id) if r.supplement_ingredient_id else None
        d = r.model_dump()
        if ing:
            d["ingredient_slug"] = ing.slug
            d["ingredient_name"] = ing.name
        out.append(_apply_detail_response_fallback(d, ing))
    return out


@router.post("/stack", status_code=201)
def add_to_stack(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    ingredient_id = body.get("supplement_ingredient_id")
    custom_name = body.get("custom_name")
    if not ingredient_id and not custom_name:
        raise HTTPException(status_code=422, detail="Either supplement_ingredient_id or custom_name is required")

    # Denormalize evidence/risk from the ingredient catalog when present
    # so the stack card renders without a join on every fetch.
    evidence = body.get("evidence_tier")
    risk = body.get("risk_tier")
    timing_notes = body.get("timing_notes")
    safety_notes = body.get("safety_notes")
    description = body.get("description")
    source_terms = body.get("source_terms")
    from app.services.supplement_details import clean_detail_list
    common_uses = clean_detail_list(body.get("common_uses"))
    deficiency_risks = clean_detail_list(body.get("deficiency_risks"))
    excess_risks = clean_detail_list(body.get("excess_risks"))
    food_sources = clean_detail_list(body.get("food_sources"))
    effectiveness_confidence = body.get("effectiveness_confidence")
    if effectiveness_confidence is not None:
        ec = str(effectiveness_confidence).strip().lower()
        effectiveness_confidence = ec if ec in {"high", "medium", "low"} else None
    category = body.get("category")
    if ingredient_id:
        ing = db.get(SupplementIngredient, int(ingredient_id))
        if not ing:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        evidence = evidence or ing.evidence_tier
        risk = risk or ing.risk_tier
        timing_notes = timing_notes or ing.timing_notes
        safety_notes = safety_notes or ing.safety_notes
        description = description or ing.description
        common_uses = common_uses or clean_detail_list(ing.common_uses)
        deficiency_risks = deficiency_risks or clean_detail_list(ing.deficiency_risks)
        excess_risks = excess_risks or clean_detail_list(ing.excess_risks)
        food_sources = food_sources or clean_detail_list(ing.food_sources)
        if not (common_uses and deficiency_risks and excess_risks and food_sources):
            from app.services.supplement_details import supplement_detail_metadata
            details = supplement_detail_metadata(ing.slug)
            common_uses = common_uses or details.get("common_uses")
            deficiency_risks = deficiency_risks or details.get("deficiency_risks")
            excess_risks = excess_risks or details.get("excess_risks")
            food_sources = food_sources or details.get("food_sources")
        if not effectiveness_confidence:
            from app.services.supplement_enrichment import confidence_from_evidence
            effectiveness_confidence = confidence_from_evidence(evidence)
        category = category or ing.category
        custom_name = custom_name or ing.name
        from app.services.supplement_enrichment import clean_source_terms, infer_source_terms
        source_terms = clean_source_terms(source_terms) or infer_source_terms(custom_name, ing.slug, category)
    else:
        from app.services.supplement_enrichment import clean_source_terms, infer_source_terms
        from app.services.supplement_details import infer_detail_slug, supplement_detail_metadata
        source_terms = clean_source_terms(source_terms) or infer_source_terms(custom_name, category)
        details = supplement_detail_metadata(infer_detail_slug(custom_name, category))
        common_uses = common_uses or details.get("common_uses")
        deficiency_risks = deficiency_risks or details.get("deficiency_risks")
        excess_risks = excess_risks or details.get("excess_risks")
        food_sources = food_sources or details.get("food_sources")

    raw_group = body.get("group_label")
    group_label = raw_group.strip() if isinstance(raw_group, str) and raw_group.strip() else None
    nutrient_content = _coerce_nutrient_content(body)
    row = UserSupplementStack(
        user_id=current_user.id,
        supplement_ingredient_id=int(ingredient_id) if ingredient_id else None,
        custom_name=custom_name,
        category=category,
        goal=body.get("goal"),
        dose_amount=float(body.get("dose_amount") or 0),
        dose_unit=str(body.get("dose_unit") or "mg"),
        frequency=str(body.get("frequency") or "daily"),
        timing=body.get("timing"),
        group_label=group_label,
        taken_with_food=bool(body.get("taken_with_food") or False),
        active=bool(body.get("active", True)),
        notes=body.get("notes"),
        description=description,
        effectiveness_confidence=effectiveness_confidence,
        evidence_tier=evidence,
        risk_tier=risk,
        timing_notes=timing_notes,
        safety_notes=safety_notes,
        common_uses=common_uses,
        deficiency_risks=deficiency_risks,
        excess_risks=excess_risks,
        food_sources=food_sources,
        source_terms=source_terms,
        nutrient_content=nutrient_content,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    ing = db.get(SupplementIngredient, row.supplement_ingredient_id) if row.supplement_ingredient_id else None
    return _apply_detail_response_fallback(row.model_dump(), ing)


@router.patch("/stack/{stack_id}")
def update_stack_item(
    stack_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = db.get(UserSupplementStack, stack_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Stack item not found")
    mutable = {"goal", "dose_amount", "dose_unit", "frequency", "timing",
               "group_label", "taken_with_food", "active", "notes", "custom_name",
               "description", "effectiveness_confidence", "evidence_tier",
               "risk_tier", "timing_notes", "safety_notes", "category", "source_terms",
               "nutrient_content", "common_uses", "deficiency_risks",
               "excess_risks", "food_sources"}
    if "custom_name" in body and "source_terms" not in body and not row.source_terms:
        from app.services.supplement_enrichment import infer_source_terms
        row.source_terms = infer_source_terms(row.custom_name, row.category, row.description)
    for k, v in body.items():
        if k in mutable:
            if k == "source_terms":
                from app.services.supplement_enrichment import clean_source_terms
                v = clean_source_terms(v)
            if k in {"common_uses", "deficiency_risks", "excess_risks", "food_sources"}:
                from app.services.supplement_details import clean_detail_list
                v = clean_detail_list(v)
            if k == "nutrient_content":
                v = _coerce_nutrient_content({"nutrient_content": v})
            # Empty string for group_label means "remove the group" — store
            # NULL so the row falls back to its `timing` bucket on render.
            if k == "group_label" and isinstance(v, str) and not v.strip():
                v = None
            setattr(row, k, v)
    db.add(row)
    db.commit()
    db.refresh(row)
    ing = db.get(SupplementIngredient, row.supplement_ingredient_id) if row.supplement_ingredient_id else None
    return _apply_detail_response_fallback(row.model_dump(), ing)


@router.delete("/stack/{stack_id}", status_code=204)
def remove_from_stack(
    stack_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = db.get(UserSupplementStack, stack_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Stack item not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


# ─── Logging ─────────────────────────────────────────────────────────────────

@router.post("/stack/{stack_id}/log", status_code=201)
def log_dose(
    stack_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Record that the user took (or skipped) a dose."""
    item = db.get(UserSupplementStack, stack_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Stack item not found")

    taken_at = datetime.now(timezone.utc)
    if body.get("taken_at"):
        try:
            taken_at = datetime.fromisoformat(str(body["taken_at"]).replace("Z", "+00:00"))
        except ValueError:
            pass

    log = SupplementLog(
        user_id=current_user.id,
        stack_item_id=stack_id,
        taken_at=taken_at,
        name=body.get("name") or item.custom_name,
        normalized_name=_normalize_supplement_name(body.get("name") or item.custom_name),
        dose_amount=body.get("dose_amount") if body.get("dose_amount") is not None else item.dose_amount,
        dose_unit=body.get("dose_unit") or item.dose_unit,
        timing_context=body.get("timing_context") or item.timing or "unknown",
        source=body.get("source") or "manual",
        confidence=body.get("confidence"),
        skipped=bool(body.get("skipped") or False),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log.model_dump()


@router.delete("/stack/{stack_id}/log")
def unlog_dose(
    stack_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Undo today's most recent dose log for a stack item — for a
    supplement accidentally marked taken (or skipped). Removes the latest
    log on the current day so the Today list flips back to "not yet".
    Returns `{deleted: 0}` (not an error) when there's nothing logged."""
    item = db.get(UserSupplementStack, stack_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Stack item not found")

    today = date.today()
    start_of_day = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    end_of_day = start_of_day + timedelta(days=1)
    log = db.exec(
        select(SupplementLog).where(
            SupplementLog.user_id == current_user.id,
            SupplementLog.stack_item_id == stack_id,
            SupplementLog.taken_at >= start_of_day,
            SupplementLog.taken_at < end_of_day,
        ).order_by(SupplementLog.taken_at.desc())
    ).first()
    if not log:
        return {"deleted": 0}
    deleted_id = log.id
    db.delete(log)
    db.commit()
    return {"deleted": 1, "log_id": deleted_id}


# ── Bulk group log ─────────────────────────────────────────────────────────
# Logs a dose for every supplement in a named group at once. Two ways to
# identify the group:
#   - `group_label`: matches `UserSupplementStack.group_label` exactly
#   - `timing`: matches `UserSupplementStack.timing` (built-in bucket)
#
# Skips items already logged today so a double-tap doesn't double-log.
# Best-effort: a single failed insert doesn't roll back the whole group.
@router.post("/stack/log-group", status_code=201)
def log_group(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    group_label = (body.get("group_label") or "").strip() if isinstance(body.get("group_label"), str) else ""
    timing = (body.get("timing") or "").strip() if isinstance(body.get("timing"), str) else ""
    skipped = bool(body.get("skipped") or False)
    if not group_label and not timing:
        raise HTTPException(status_code=400, detail="group_label or timing required")

    q = select(UserSupplementStack).where(
        UserSupplementStack.user_id == current_user.id,
        UserSupplementStack.active == True,  # noqa: E712
    )
    if group_label:
        q = q.where(UserSupplementStack.group_label == group_label)
    else:
        # When falling back to timing, exclude items that have a custom
        # group_label set — those belong to their own group, not the
        # built-in timing bucket.
        q = q.where(
            UserSupplementStack.timing == timing,
            UserSupplementStack.group_label == None,  # noqa: E711
        )
    items = list(db.exec(q).all())
    if not items:
        return {"logged": 0, "items": []}

    today = date.today()
    start_of_day = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    end_of_day = start_of_day + timedelta(days=1)

    # Items already logged today (taken or skipped) are no-ops so a
    # repeat tap doesn't double-record.
    already_logged_ids = {
        l.stack_item_id for l in db.exec(
            select(SupplementLog).where(
                SupplementLog.user_id == current_user.id,
                SupplementLog.stack_item_id.in_([i.id for i in items]),
                SupplementLog.taken_at >= start_of_day,
                SupplementLog.taken_at < end_of_day,
            )
        ).all()
    }

    now = datetime.now(timezone.utc)
    logged_ids: list[int] = []
    for item in items:
        if item.id in already_logged_ids:
            continue
        try:
            db.add(SupplementLog(
                user_id=current_user.id,
                stack_item_id=item.id,
                taken_at=now,
                name=item.custom_name,
                normalized_name=_normalize_supplement_name(item.custom_name),
                dose_amount=item.dose_amount,
                dose_unit=item.dose_unit,
                timing_context=item.timing or timing or "unknown",
                source="manual",
                confidence=1.0,
                skipped=skipped,
            ))
            logged_ids.append(item.id)
        except Exception:
            # Single-item failure shouldn't strand the rest of the batch.
            continue
    if logged_ids:
        db.commit()
    return {"logged": len(logged_ids), "items": logged_ids}


@router.get("/today")
def today_schedule(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """What's scheduled today + what's already been taken, so the client
    renders a single "Today" list (Taken / Not yet / Skipped)."""
    today = date.today()
    start_of_day = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    end_of_day = start_of_day + timedelta(days=1)

    stack = db.exec(
        select(UserSupplementStack).where(
            UserSupplementStack.user_id == current_user.id,
            UserSupplementStack.active == True,  # noqa: E712
        )
    ).all()
    logs = db.exec(
        select(SupplementLog).where(
            SupplementLog.user_id == current_user.id,
            SupplementLog.taken_at >= start_of_day,
            SupplementLog.taken_at < end_of_day,
        )
    ).all()
    logs_by_item: dict[int, list[dict]] = {}
    for log in logs:
        logs_by_item.setdefault(log.stack_item_id, []).append(log.model_dump())

    ing_ids = [s.supplement_ingredient_id for s in stack if s.supplement_ingredient_id]
    ing_by_id: dict[int, SupplementIngredient] = {}
    if ing_ids:
        ings = db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ing_ids))).all()
        ing_by_id = {i.id: i for i in ings}

    out = []
    for item in stack:
        # Simple frequency filter — "daily" always scheduled; weekdays
        # only Mon-Fri; "as_needed" never surfaces on the Today list.
        freq = (item.frequency or "daily").lower()
        if freq == "weekdays" and today.weekday() >= 5:
            continue
        if freq == "as_needed":
            continue
        d = item.model_dump()
        d["logs_today"] = logs_by_item.get(item.id or -1, [])
        ing = ing_by_id.get(item.supplement_ingredient_id) if item.supplement_ingredient_id else None
        d["ingredient_slug"] = ing.slug if ing else None
        d["ingredient_name"] = ing.name if ing else None
        d = _apply_detail_response_fallback(d, ing)
        out.append(d)
    return out


@router.get("/history")
def supplement_history(
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=200, ge=1, le=500),
    stack_item_id: int | None = Query(default=None, ge=1),
    ingredient_slug: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Recent supplement dose history, grouped client-side by date.

    Logs preserve the frozen dose/name snapshot from when the user logged
    the dose; stack/ingredient fields are included as convenience context.
    """
    def empty_response() -> dict:
        return {
            "days": days,
            "limit": limit,
            "summary": {
                "taken": 0,
                "skipped": 0,
                "taken_days": 0,
            },
            "items": [],
        }

    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    filters = [
        SupplementLog.user_id == current_user.id,
        SupplementLog.taken_at >= start,
    ]
    if stack_item_id is not None:
        filters.append(SupplementLog.stack_item_id == stack_item_id)

    slug = (ingredient_slug or "").strip()
    if slug:
        ingredient = db.exec(
            select(SupplementIngredient).where(SupplementIngredient.slug == slug)
        ).first()
        if not ingredient or ingredient.id is None:
            return empty_response()
        slug_stack_ids = [
            int(s.id) for s in db.exec(
                select(UserSupplementStack).where(
                    UserSupplementStack.user_id == current_user.id,
                    UserSupplementStack.supplement_ingredient_id == ingredient.id,
                )
            ).all()
            if s.id is not None
        ]
        if not slug_stack_ids:
            return empty_response()
        filters.append(SupplementLog.stack_item_id.in_(slug_stack_ids))

    logs = db.exec(
        select(SupplementLog).where(*filters).order_by(SupplementLog.taken_at.desc()).limit(limit)
    ).all()

    stack_ids = [l.stack_item_id for l in logs if l.stack_item_id is not None]
    stack_by_id: dict[int, UserSupplementStack] = {}
    if stack_ids:
        stack_rows = db.exec(
            select(UserSupplementStack).where(UserSupplementStack.id.in_(stack_ids))
        ).all()
        stack_by_id = {int(s.id): s for s in stack_rows if s.id is not None}

    ing_ids = [
        s.supplement_ingredient_id
        for s in stack_by_id.values()
        if s.supplement_ingredient_id
    ]
    ing_by_id: dict[int, SupplementIngredient] = {}
    if ing_ids:
        ings = db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ing_ids))).all()
        ing_by_id = {int(i.id): i for i in ings if i.id is not None}

    items: list[dict] = []
    taken_days = set()
    taken_count = 0
    skipped_count = 0
    for log in logs:
        stack_item = stack_by_id.get(log.stack_item_id)
        ing = ing_by_id.get(stack_item.supplement_ingredient_id) if stack_item and stack_item.supplement_ingredient_id else None
        if log.skipped:
            skipped_count += 1
        else:
            taken_count += 1
            taken_days.add(log.taken_at.date().isoformat())
        d = log.model_dump()
        d["display_name"] = log.name or (stack_item.custom_name if stack_item else None) or (ing.name if ing else None) or "Supplement"
        d["category"] = stack_item.category if stack_item else None
        d["timing"] = stack_item.timing if stack_item else None
        d["group_label"] = stack_item.group_label if stack_item else None
        d["active"] = stack_item.active if stack_item else None
        d["supplement_ingredient_id"] = stack_item.supplement_ingredient_id if stack_item else None
        d["ingredient_slug"] = ing.slug if ing else None
        d["ingredient_name"] = ing.name if ing else None
        d["usage_guidance"] = _apply_detail_response_fallback(
            {
                "custom_name": d["display_name"],
                "category": d["category"],
                "dose_amount": d.get("dose_amount"),
                "dose_unit": d.get("dose_unit"),
            },
            ing,
        ).get("usage_guidance")
        items.append(d)

    return {
        "days": days,
        "limit": limit,
        "summary": {
            "taken": taken_count,
            "skipped": skipped_count,
            "taken_days": len(taken_days),
        },
        "items": items,
    }


# ─── Recommendations + insights ──────────────────────────────────────────────

@router.get("/recommendations")
def recommendations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Goal/training/diet/profile-aware supplement suggestions.

    Delegates to `services.supplement_recs.build_recommendations` which
    composes signals from:
      - User profile (age, gender, weight)
      - Active goal (type + pace)
      - Last 14 days of workouts (hard sessions, cardio volume)
      - 14-day diet rollup (fiber, omega-3, plants, protein adequacy,
        plant/animal split, sat fat, fermented foods)
      - Current stack (avoids duplicates, respects category overlaps)

    Cautious language enforced: "may support", "consider", "useful for".
    Never "fixes" / "boosts hormones" / "prevents disease"."""
    from app.services.supplement_recs import build_recommendations
    return build_recommendations(db, current_user.id)


@router.get("/insights")
def insights(
    current_user: User = Depends(require_pro_feature("Supplement insights")),
    db: Session = Depends(get_session),
):
    """Compute daily-level insights from the user's supplement logs +
    stack. V1 covers:
      • Late caffeine warning — caffeine logged after 2pm local
      • Stimulant stacking — 2+ stimulants taken within 2 hours
      • Creatine consistency — % days logged in last 7
    """
    today = date.today()
    since_30 = today - timedelta(days=30)
    since_7 = today - timedelta(days=7)
    start_of_window = datetime.combine(since_30, datetime.min.time(), tzinfo=timezone.utc)
    start_of_week = datetime.combine(since_7, datetime.min.time(), tzinfo=timezone.utc)

    stack = db.exec(
        select(UserSupplementStack).where(UserSupplementStack.user_id == current_user.id)
    ).all()
    stack_by_id = {s.id: s for s in stack}

    logs = db.exec(
        select(SupplementLog).where(
            SupplementLog.user_id == current_user.id,
            SupplementLog.taken_at >= start_of_window,
        )
    ).all()
    logs_7 = [log for log in logs if log.taken_at >= start_of_week]

    insights: list[dict] = []

    # Late caffeine — any log >= 14:00 local (approximated as UTC here;
    # client can refine if we ship TZ-aware later).
    caffeine_ing_id = None
    for ing in db.exec(select(SupplementIngredient).where(SupplementIngredient.slug == "caffeine")).all():
        caffeine_ing_id = ing.id
        break
    if caffeine_ing_id:
        late_caffeine_logs = [
            log for log in logs_7
            if not log.skipped
            and stack_by_id.get(log.stack_item_id)
            and stack_by_id[log.stack_item_id].supplement_ingredient_id == caffeine_ing_id
            and log.taken_at.hour >= 14
        ]
        if late_caffeine_logs:
            insights.append({
                "key": "late_caffeine",
                "severity": "warning",
                "title": f"Caffeine logged after 2 PM ({len(late_caffeine_logs)} time{'s' if len(late_caffeine_logs) != 1 else ''} this week)",
                "body": "Late caffeine (after ~2 PM) can hurt sleep quality even when you fall asleep easily. Consider shifting earlier.",
            })

    ing_ids = [s.supplement_ingredient_id for s in stack if s.supplement_ingredient_id]
    ing_by_id: dict[int, SupplementIngredient] = {}
    if ing_ids:
        ings = db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ing_ids))).all()
        ing_by_id = {int(i.id): i for i in ings if i.id is not None}

    from app.services.supplement_usage import build_usage_guidance_insights
    existing_keys = {i.get("key") for i in insights}
    for insight in build_usage_guidance_insights(
        stack=list(stack),
        ingredients_by_id=ing_by_id,
        logs=list(logs),
        today=today,
    ):
        if insight.get("key") not in existing_keys:
            insights.append(insight)
            existing_keys.add(insight.get("key"))

    # Creatine consistency — count days with a non-skipped log in last 7.
    creatine_ing_id = None
    for ing in db.exec(select(SupplementIngredient).where(SupplementIngredient.slug == "creatine_monohydrate")).all():
        creatine_ing_id = ing.id
        break
    if creatine_ing_id:
        has_creatine_in_stack = any(
            s.supplement_ingredient_id == creatine_ing_id and s.active for s in stack
        )
        if has_creatine_in_stack:
            days_logged = len({
                log.taken_at.date() for log in logs_7
                if not log.skipped
                and stack_by_id.get(log.stack_item_id)
                and stack_by_id[log.stack_item_id].supplement_ingredient_id == creatine_ing_id
            })
            insights.append({
                "key": "creatine_consistency",
                "severity": "info" if days_logged >= 5 else "warning",
                "title": f"Creatine consistency: {days_logged}/7 days",
                "body": "Creatine works via saturation, so daily consistency matters more than perfect timing.",
            })

    return {"insights": insights}
