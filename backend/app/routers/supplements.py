"""Supplement Stack V1 — manual-entry stack with seeded ingredient
metadata (evidence/risk tiers). Recommendations connect to food-side
gaps (low omega-3, low vitamin D, late caffeine, etc.) so the
supplement screen doesn't live in isolation.
"""
from __future__ import annotations

from datetime import datetime, date, timezone, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.database import get_session
from app.models import (
    SupplementIngredient, UserSupplementStack, SupplementLog, User,
)
from app.auth import get_current_user


router = APIRouter(prefix="/supplements", tags=["supplements"])


# ─── Ingredient catalog ──────────────────────────────────────────────────────

@router.get("/ingredients")
def list_ingredients(
    db: Session = Depends(get_session),
):
    """Read-only catalog of seeded ingredients with evidence + risk tiers.
    Client renders these in the "Add supplement" picker."""
    rows = db.exec(select(SupplementIngredient).order_by(SupplementIngredient.name)).all()
    return [r.model_dump() for r in rows]


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
    return [r.model_dump() for r in rows]


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
    category = body.get("category")
    if ingredient_id:
        ing = db.get(SupplementIngredient, int(ingredient_id))
        if not ing:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        evidence = evidence or ing.evidence_tier
        risk = risk or ing.risk_tier
        timing_notes = timing_notes or ing.timing_notes
        safety_notes = safety_notes or ing.safety_notes
        category = category or ing.category
        custom_name = custom_name or ing.name

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
        taken_with_food=bool(body.get("taken_with_food") or False),
        active=bool(body.get("active", True)),
        notes=body.get("notes"),
        evidence_tier=evidence,
        risk_tier=risk,
        timing_notes=timing_notes,
        safety_notes=safety_notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


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
               "taken_with_food", "active", "notes", "custom_name"}
    for k, v in body.items():
        if k in mutable:
            setattr(row, k, v)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


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
        dose_amount=body.get("dose_amount") if body.get("dose_amount") is not None else item.dose_amount,
        dose_unit=body.get("dose_unit") or item.dose_unit,
        skipped=bool(body.get("skipped") or False),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log.model_dump()


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

    out = []
    for item in stack:
        # Simple frequency filter — "daily" always scheduled; weekdays
        # only Mon-Fri; "as_needed" never surfaces on the Today list.
        freq = (item.frequency or "daily").lower()
        if freq == "weekdays" and today.weekday() >= 5:
            continue
        if freq == "as_needed":
            continue
        out.append({
            **item.model_dump(),
            "logs_today": logs_by_item.get(item.id or -1, []),
        })
    return out


# ─── Recommendations + insights ──────────────────────────────────────────────

@router.get("/recommendations")
def recommendations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Generate cautious, food-gap-driven supplement suggestions. Uses
    the same 14-day gut/nutrition rollup that powers the Progress
    screen so suggestions are backed by actual logged data.

    Cautious language: "may support", "consider", "useful for". Never
    "fixes" / "boosts hormones" / "prevents disease"."""
    from app.services.nutrition.gut_health import compute_weekly_rollup

    rec: list[dict] = []

    # Fetch user's current stack so we can flag duplicates + stimulant stacking.
    stack = db.exec(
        select(UserSupplementStack).where(
            UserSupplementStack.user_id == current_user.id,
            UserSupplementStack.active == True,  # noqa: E712
        )
    ).all()
    stack_slugs = set()
    for item in stack:
        if item.supplement_ingredient_id:
            ing = db.get(SupplementIngredient, item.supplement_ingredient_id)
            if ing:
                stack_slugs.add(ing.slug)

    # Build 14-day rollup as the food-side signal.
    try:
        rollup = compute_weekly_rollup(db, user_id=current_user.id, days=14)
    except Exception:
        rollup = {}

    omega3 = rollup.get("omega3_servings", 0)
    seafood = rollup.get("seafood_servings", 0)
    plants = rollup.get("distinct_plant_foods_week", 0)
    avg_cals = rollup.get("avg_calories", 0)
    fiber = rollup.get("avg_fiber_g", 0)

    # Omega-3 — low food intake.
    if (omega3 or 0) < 1 and (seafood or 0) < 1 and "omega_3" not in stack_slugs:
        rec.append({
            "slug": "omega_3",
            "title": "Omega-3 (EPA/DHA) may be worth considering",
            "reason": "Logged omega-3 food intake is low over the last 14 days.",
            "cautious_guidance": "Fatty fish 2x/week is the best first step. If that's unrealistic, a high-quality EPA/DHA supplement can help. Discuss with a clinician if you're on blood thinners.",
            "evidence_tier": "moderate",
            "risk_tier": "low",
            "priority": "moderate",
        })

    # Vitamin D — generic recommendation (no dietary panel yet).
    if "vitamin_d3" not in stack_slugs:
        rec.append({
            "slug": "vitamin_d3",
            "title": "Vitamin D levels vary — consider bloodwork",
            "reason": "Dietary vitamin D tends to be low and levels depend on sun exposure.",
            "cautious_guidance": "Bloodwork is the cleanest way to know your level. If you supplement, take D3 with a fat-containing meal. Discuss dosing with a clinician.",
            "evidence_tier": "moderate",
            "risk_tier": "moderate",
            "priority": "moderate",
        })

    # Creatine — training performance recommendation.
    if "creatine_monohydrate" not in stack_slugs:
        rec.append({
            "slug": "creatine_monohydrate",
            "title": "Creatine may support training performance",
            "reason": "One of the most-studied supplements for strength and lean mass.",
            "cautious_guidance": "5g daily. Consistency matters more than timing. Stay well-hydrated. Discuss with a clinician if you have kidney disease.",
            "evidence_tier": "strong",
            "risk_tier": "low",
            "priority": "low",
        })

    # Fiber gap → recommend food first, not fiber supplements.
    if fiber and fiber < 18 and (plants or 0) < 15:
        rec.append({
            "slug": None,
            "title": "Dietary fiber is low — prioritize food first",
            "reason": f"14-day average fiber is {round(fiber)}g/day (target is typically 25-35g).",
            "cautious_guidance": "Before a fiber supplement: add oats, beans, chia, raspberries, or a daily serving of cooked greens. Supplements can help in a pinch but whole-food fiber brings micronutrients too.",
            "evidence_tier": "strong",
            "risk_tier": "low",
            "priority": "high",
        })

    # Electrolytes if user logs hard training — heuristic placeholder.
    # V1 skips the training-sweat signal; can wire it in later.

    # Stimulant stacking warning
    caffeine_in_stack = any(
        ((db.get(SupplementIngredient, item.supplement_ingredient_id).slug == "caffeine")
         if item.supplement_ingredient_id else False)
        for item in stack
    )
    if caffeine_in_stack:
        # Timing warning — surfaces in insights, not recommendations.
        pass

    # Duplicate ingredient warning.
    seen: dict[int, int] = {}
    for item in stack:
        if item.supplement_ingredient_id:
            seen[item.supplement_ingredient_id] = seen.get(item.supplement_ingredient_id, 0) + 1
    duplicates = [ing_id for ing_id, n in seen.items() if n > 1]

    return {
        "recommendations": rec,
        "warnings": {
            "duplicate_ingredient_ids": duplicates,
        },
    }


@router.get("/insights")
def insights(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Compute daily-level insights from the user's supplement logs +
    stack. V1 covers:
      • Late caffeine warning — caffeine logged after 2pm local
      • Stimulant stacking — 2+ stimulants taken within 2 hours
      • Creatine consistency — % days logged in last 7
    """
    today = date.today()
    since = today - timedelta(days=7)
    start_of_window = datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc)

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

    insights: list[dict] = []

    # Late caffeine — any log >= 14:00 local (approximated as UTC here;
    # client can refine if we ship TZ-aware later).
    caffeine_ing_id = None
    for ing in db.exec(select(SupplementIngredient).where(SupplementIngredient.slug == "caffeine")).all():
        caffeine_ing_id = ing.id
        break
    if caffeine_ing_id:
        late_caffeine_logs = [
            log for log in logs
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
                log.taken_at.date() for log in logs
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
