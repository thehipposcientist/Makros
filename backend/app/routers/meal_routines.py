"""Meal Routines — server-owned recurring scheduled-meal templates.

This is the durable successor to the old AsyncStorage-only "mealRoutines"
list. Routines are TEMPLATES, never logged meals. The three concepts the
rest of the app depends on stay strictly separated:

  * MealRoutine               — the recurring template + schedule (this file)
  * RoutineOccurrenceException — a per-date override for an un-logged day
  * Meal / MealItem            — the concrete logged instance for one date

Hard rules enforced here (mirrors the product spec):
  D. Logging an occurrence creates/updates EXACTLY ONE Meal, deduped by the
     (user_id, source_routine_id, routine_occurrence_key) unique index.
  E. Editing a routine updates THIS routine row only — never duplicates it,
     never rewrites already-logged Meal rows.
  F. Editing one day either updates that day's logged Meal (if logged) or
     writes a RoutineOccurrenceException (if not) — never the base routine.
  H. Deleting a routine archives it (active=False); historical logs survive.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select, delete as _sm_delete

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import FREE_MEAL_ROUTINE_LIMIT, is_pro
from app.enums import MealSource, MealType
from app.models import (
    Food,
    Meal,
    MealItem,
    MealRoutine,
    RoutineOccurrenceException,
    User,
)
from app.services.nutrition.added_sugar import resolve_added_sugar_g

router = APIRouter(prefix="/meals/routines", tags=["meals"])


# ─── Schemas ──────────────────────────────────────────────────────────────────

class RoutineUpsert(BaseModel):
    name: str
    notes: str | None = None
    meal_type: str | None = None
    days_of_week: list[int] | None = None
    default_time: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    active: bool | None = None
    source_template_id: int | None = None
    display_order: int | None = None
    items: list[dict] | None = None
    # Client idempotency token. A retried / double-submitted create with the
    # same key returns the already-created routine instead of duplicating it.
    idempotency_key: str | None = None


class RoutinePatch(BaseModel):
    name: str | None = None
    notes: str | None = None
    meal_type: str | None = None
    days_of_week: list[int] | None = None
    default_time: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    active: bool | None = None
    display_order: int | None = None
    items: list[dict] | None = None


class LogOccurrenceBody(BaseModel):
    occurrence_date: str | None = None      # "YYYY-MM-DD"; defaults to today
    occurrence_key: str | None = None       # stable per-occurrence id
    meal_type: str | None = None
    consumed_at: datetime | None = None
    idempotency_key: str | None = None


class OccurrencePatch(BaseModel):
    occurrence_date: str                    # required — which day this edits
    occurrence_key: str | None = None
    name: str | None = None
    items: list[dict] | None = None
    override_time: str | None = None
    skipped: bool | None = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _totals(items: list[dict]) -> tuple[float, float, float, float]:
    cal = sum(float(i.get("calories") or 0) for i in items)
    p = sum(float(i.get("protein_g") or i.get("protein") or 0) for i in items)
    c = sum(float(i.get("carbs_g") or i.get("carbs") or 0) for i in items)
    f = sum(float(i.get("fat_g") or i.get("fat") or 0) for i in items)
    return round(cal, 1), round(p, 1), round(c, 1), round(f, 1)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _resolve_meal_type(raw: str | None, fallback: MealType = MealType.SNACK) -> MealType:
    if not raw:
        return fallback
    try:
        return MealType(str(raw).lower())
    except ValueError:
        return fallback


def resolve_occurrence_key(routine: MealRoutine, occ_date: date, explicit: str | None = None) -> str:
    """Canonical, stable identity for ONE routine occurrence on ONE date.

    MUST NOT depend on the display ``meal_type`` — otherwise the same
    routine/date produces different keys depending on whether the client sent
    meal_type, which breaks the (user, source_routine_id, routine_occurrence_key)
    dedup and lets the same occurrence log twice (the routine-duplicate bug).
    Prefer a client-supplied key; else derive purely from the routine's own
    schedule (its default_time), never from the request's meal_type.
    """
    key = (explicit or "").strip()
    if key:
        return key
    return f"routine:{routine.id}:{occ_date.isoformat()}:{(routine.default_time or '').strip()}"


def _combine_date_time(d: date, hhmm: str | None) -> datetime | None:
    """Combine an occurrence date with an "HH:MM" override into a UTC datetime.
    Returns None when the time is missing/unparseable so callers fall back."""
    if not hhmm:
        return None
    try:
        from datetime import time as _time_cls
        parts = str(hhmm).split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
        return datetime.combine(d, _time_cls(hour, minute), tzinfo=timezone.utc)
    except (TypeError, ValueError, IndexError):
        return None


def get_routine_exception(
    db: Session, user_id: int, routine_id: int, occ_date: date,
) -> RoutineOccurrenceException | None:
    """Per-date override for an UN-logged routine occurrence. Keyed by
    (user, routine, date) — the table's unique constraint — so lookups are
    stable regardless of how the occurrence_key is spelled."""
    return db.exec(
        select(RoutineOccurrenceException)
        .where(RoutineOccurrenceException.user_id == user_id)
        .where(RoutineOccurrenceException.routine_id == routine_id)
        .where(RoutineOccurrenceException.occurrence_date == occ_date)
    ).first()


def upsert_routine_exception(
    db: Session,
    *,
    user_id: int,
    routine_id: int,
    occ_date: date,
    occurrence_key: str | None = None,
    override_time: str | None = None,
    skipped: bool | None = None,
    edited_payload: dict | None = None,
) -> RoutineOccurrenceException:
    """Create or update the (user, routine, date) exception in place. Does not
    commit — the caller owns the transaction."""
    exc = get_routine_exception(db, user_id, routine_id, occ_date)
    if exc is None:
        exc = RoutineOccurrenceException(
            user_id=user_id,
            routine_id=routine_id,
            occurrence_date=occ_date,
            occurrence_key=occurrence_key,
            override_time=override_time,
            skipped=bool(skipped),
            edited_payload=edited_payload,
        )
    else:
        if occurrence_key is not None:
            exc.occurrence_key = occurrence_key
        if override_time is not None:
            exc.override_time = override_time
        if skipped is not None:
            exc.skipped = bool(skipped)
        if edited_payload is not None:
            exc.edited_payload = edited_payload
        exc.updated_at = datetime.now(timezone.utc)
    db.add(exc)
    return exc


def _clone_items_into_meal(db: Session, user_id: int, meal_id: int, items: list[dict]) -> None:
    """Snapshot routine JSON items into meal_items rows. Backfills food_id by
    tolerant name match so the gut-health pipeline keeps working, but macros
    are always taken from the snapshot, never recomputed from live foods."""
    needed = {
        _norm(it.get("food_name") or it.get("name") or "")
        for it in (items or [])
        if not it.get("food_id") and (it.get("food_name") or it.get("name"))
    }
    food_by_name: dict[str, int] = {}
    if needed:
        # Only ever attach a catalog/public food (owner_user_id IS NULL) or one
        # owned by THIS user. Matching across all rows by name could link a
        # routine item to another user's private custom food via name collision.
        owned_or_public = db.exec(
            select(Food)
            .where((Food.owner_user_id == None) | (Food.owner_user_id == user_id))  # noqa: E711
            .where(Food.is_active == True)  # noqa: E712
        ).all()
        for f in owned_or_public:
            key = _norm(f.name or "")
            if key and key in needed and key not in food_by_name:
                food_by_name[key] = f.id
    for it in items or []:
        fid = it.get("food_id")
        if not fid:
            fid = food_by_name.get(_norm(it.get("food_name") or it.get("name") or ""))
        sugar_g = it.get("sugar_g") if it.get("sugar_g") is not None else it.get("sugar")
        added_sugar_g = resolve_added_sugar_g(
            it.get("food_name") or it.get("name"),
            reported_added_sugar_g=it.get("added_sugar_g") if it.get("added_sugar_g") is not None else it.get("added_sugar"),
            sugar_g=sugar_g,
            serving_grams=it.get("serving_grams"),
        )
        db.add(MealItem(
            meal_id=meal_id,
            food_name=it.get("food_name") or it.get("name") or "Item",
            food_id=fid,
            serving_id=it.get("serving_id"),
            quantity=float(it.get("quantity") or 1),
            unit=str(it.get("unit") or "serving"),
            serving_grams=it.get("serving_grams"),
            calories=float(it.get("calories") or 0),
            protein_g=float(it.get("protein_g") or it.get("protein") or 0),
            carbs_g=float(it.get("carbs_g") or it.get("carbs") or 0),
            fat_g=float(it.get("fat_g") or it.get("fat") or 0),
            fiber_g=it.get("fiber_g") if it.get("fiber_g") is not None else it.get("fiber"),
            sugar_g=sugar_g,
            added_sugar_g=added_sugar_g,
            sodium_mg=it.get("sodium_mg") if it.get("sodium_mg") is not None else it.get("sodium"),
        ))


def _routine_or_404(db: Session, routine_id: int, user: User) -> MealRoutine:
    routine = db.get(MealRoutine, routine_id)
    if not routine or routine.user_id != user.id:
        raise HTTPException(status_code=404, detail="Routine not found")
    return routine


def _next_display_order(db: Session, user_id: int) -> int:
    max_order = db.exec(
        select(MealRoutine.display_order)
        .where(MealRoutine.user_id == user_id)
        .order_by(MealRoutine.display_order.desc(), MealRoutine.id.desc())
    ).first()
    return int(max_order) + 1 if max_order is not None else 0


def _enforce_routine_cap(db: Session, user: User) -> None:
    if is_pro(user):
        return
    count = db.exec(
        select(MealRoutine.id)
        .where(MealRoutine.user_id == user.id)
        .where(MealRoutine.active == True)  # noqa: E712
    ).all()
    if len(count) >= FREE_MEAL_ROUTINE_LIMIT:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Free accounts can pin up to {FREE_MEAL_ROUTINE_LIMIT} meal routines. "
                "Upgrade to Pro for unlimited routines."
            ),
        )


def _refresh(db: Session, user_id: int, meal_date: date) -> None:
    try:
        from app.routers.meals import _refresh_daily_metrics
        _refresh_daily_metrics(db, user_id, meal_date, force=True)
    except Exception:
        pass


# ─── Routine CRUD (template only — never logs a meal) ──────────────────────────

@router.get("")
def list_routines(
    include_inactive: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    q = select(MealRoutine).where(MealRoutine.user_id == current_user.id)
    if not include_inactive:
        q = q.where(MealRoutine.active == True)  # noqa: E712
    rows = db.exec(q.order_by(MealRoutine.display_order, MealRoutine.created_at, MealRoutine.id)).all()
    return [r.model_dump() for r in rows]


@router.post("", status_code=201)
def create_routine(
    body: RoutineUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    from sqlalchemy.exc import IntegrityError

    items = body.items or []
    cal, p, c, f = _totals(items)
    active = body.active if body.active is not None else True
    idem = (body.idempotency_key or "").strip() or None
    # Idempotent create: a retried / double-submitted "make routine" with the
    # same client key returns the already-created routine instead of inserting
    # a duplicate — the duplicated-routine bug.
    if idem:
        existing = db.exec(
            select(MealRoutine)
            .where(MealRoutine.user_id == current_user.id)
            .where(MealRoutine.idempotency_key == idem)
        ).first()
        if existing is not None:
            return existing.model_dump()
    if active:
        _enforce_routine_cap(db, current_user)
    routine = MealRoutine(
        user_id=current_user.id,
        name=body.name,
        notes=body.notes,
        meal_type=_resolve_meal_type(body.meal_type, None) if body.meal_type else None,
        days_of_week=body.days_of_week or [],
        default_time=body.default_time,
        start_date=body.start_date,
        end_date=body.end_date,
        active=active,
        source_template_id=body.source_template_id,
        idempotency_key=idem,
        total_calories=cal, total_protein_g=p, total_carbs_g=c, total_fat_g=f,
        items=items,
        display_order=max(0, int(body.display_order)) if body.display_order is not None else _next_display_order(db, current_user.id),
    )
    db.add(routine)
    try:
        db.commit()
    except IntegrityError:
        # Lost a race on the (user_id, idempotency_key) unique index — the
        # other request already created the row. Return the winner.
        db.rollback()
        if idem:
            existing = db.exec(
                select(MealRoutine)
                .where(MealRoutine.user_id == current_user.id)
                .where(MealRoutine.idempotency_key == idem)
            ).first()
            if existing is not None:
                return existing.model_dump()
        raise
    db.refresh(routine)
    return routine.model_dump()


@router.patch("/{routine_id}")
def update_routine(
    routine_id: int,
    body: RoutinePatch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Edit the routine template IN PLACE. Never duplicates the routine, never
    rewrites already-logged meals (rule E)."""
    routine = _routine_or_404(db, routine_id, current_user)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        routine.name = data["name"]
    if "notes" in data:
        routine.notes = data["notes"]
    if "meal_type" in data:
        routine.meal_type = _resolve_meal_type(data["meal_type"], None) if data["meal_type"] else None
    if "days_of_week" in data and data["days_of_week"] is not None:
        routine.days_of_week = data["days_of_week"]
    if "default_time" in data:
        routine.default_time = data["default_time"]
    if "start_date" in data:
        routine.start_date = data["start_date"]
    if "end_date" in data:
        routine.end_date = data["end_date"]
    if "active" in data and data["active"] is not None:
        if data["active"] and not routine.active:
            _enforce_routine_cap(db, current_user)
        routine.active = data["active"]
    if "display_order" in data and data["display_order"] is not None:
        routine.display_order = max(0, int(data["display_order"]))
    if "items" in data and isinstance(data["items"], list):
        routine.items = data["items"]
        cal, p, c, f = _totals(data["items"])
        routine.total_calories, routine.total_protein_g = cal, p
        routine.total_carbs_g, routine.total_fat_g = c, f
    routine.updated_at = datetime.now(timezone.utc)
    db.add(routine)
    db.commit()
    db.refresh(routine)
    return routine.model_dump()


@router.delete("/{routine_id}")
def delete_routine(
    routine_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Archive the routine (active=False). Historical logs keep their
    source_routine_id for traceability and are NOT deleted (rule H)."""
    routine = _routine_or_404(db, routine_id, current_user)
    routine.active = False
    routine.updated_at = datetime.now(timezone.utc)
    db.add(routine)
    db.commit()
    return {"archived": routine_id}


# ─── Occurrence logging (creates exactly one Meal) ─────────────────────────────

@router.post("/{routine_id}/log", status_code=201)
def log_routine_occurrence(
    routine_id: int,
    body: LogOccurrenceBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Log one routine occurrence as a single Meal. Idempotent on
    (user_id, source_routine_id, routine_occurrence_key) so logging the same
    occurrence twice (double tap / retry) never duplicates (rule D)."""
    routine = _routine_or_404(db, routine_id, current_user)
    occ_date = date.fromisoformat(body.occurrence_date) if body.occurrence_date else date.today()
    # Canonical occurrence key — independent of meal_type (rule B).
    occ_key = resolve_occurrence_key(routine, occ_date, body.occurrence_key)

    def _winner_query():
        return db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.source_routine_id == routine_id)
            .where(Meal.routine_occurrence_key == occ_key)
        ).first()

    # Already logged this occurrence? Return it unchanged (rule D dedup).
    existing = _winner_query()
    if existing is not None:
        return {"meal_id": existing.id, "source_routine_id": routine_id,
                "routine_occurrence_key": occ_key, "deduped": True}

    # Apply any one-day exception for this UN-logged occurrence (rule C).
    exc = get_routine_exception(db, current_user.id, routine_id, occ_date)
    if exc is not None and exc.skipped:
        # Skipped day must not log (and a later retry must keep being blocked).
        raise HTTPException(
            status_code=409,
            detail="This routine occurrence is marked skipped for this date.",
        )

    name = routine.name
    notes = routine.notes
    items = routine.items or []
    if exc is not None and exc.edited_payload:
        edited = exc.edited_payload or {}
        if edited.get("name"):
            name = edited["name"]
        if isinstance(edited.get("items"), list):
            items = edited["items"]

    mt = _resolve_meal_type(body.meal_type or (routine.meal_type.value if routine.meal_type else None))

    # consumed_at: explicit body value wins; else an occurrence override_time;
    # else now. The occurrence key never depends on this.
    consumed_at = body.consumed_at
    if consumed_at is None and exc is not None and exc.override_time:
        consumed_at = _combine_date_time(occ_date, exc.override_time)
    if consumed_at is None:
        consumed_at = datetime.now(timezone.utc)

    idem_key = (body.idempotency_key or "").strip() or None

    meal = Meal(
        user_id=current_user.id,
        meal_date=occ_date,
        meal_type=mt,
        name=name,
        source=MealSource.LOGGED,
        notes=notes,
        consumed_at=consumed_at,
        source_type="routine",
        source_routine_id=routine_id,
        routine_occurrence_key=occ_key,
        idempotency_key=idem_key,
        client_meal_key=(mt.value if mt else None),
    )
    db.add(meal)
    # Insert + flush + clone + commit all inside the IntegrityError recovery so
    # a race that trips the (user, source_routine_id, occurrence_key) unique
    # index returns the winning row instead of 500-ing (rule A).
    try:
        db.flush()
        _clone_items_into_meal(db, current_user.id, meal.id, items)
        db.commit()
    except IntegrityError:
        db.rollback()
        winner = _winner_query()
        if winner is not None:
            return {"meal_id": winner.id, "source_routine_id": routine_id,
                    "routine_occurrence_key": occ_key, "deduped": True}
        raise
    db.refresh(meal)
    _refresh(db, current_user.id, occ_date)
    return {"meal_id": meal.id, "source_routine_id": routine_id,
            "routine_occurrence_key": occ_key, "deduped": False}


@router.put("/{routine_id}/occurrence")
def update_routine_occurrence(
    routine_id: int,
    body: OccurrencePatch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Edit ONE day of a routine (rule F). If that day is already logged,
    update its Meal row. Otherwise upsert a RoutineOccurrenceException. Never
    touches the base routine."""
    routine = _routine_or_404(db, routine_id, current_user)
    occ_date = date.fromisoformat(body.occurrence_date)
    occ_key = resolve_occurrence_key(routine, occ_date, body.occurrence_key)

    # Find the concrete logged occurrence by its STABLE key — never "latest
    # logged meal for routine+date", which mutates the wrong row when a day
    # has multiple occurrences or leftover duplicates (rule D).
    logged = db.exec(
        select(Meal)
        .where(Meal.user_id == current_user.id)
        .where(Meal.source_routine_id == routine_id)
        .where(Meal.routine_occurrence_key == occ_key)
    ).first()
    if logged is None:
        # Migration-compat ONLY: rows logged before occurrence keys were stable
        # may have a null/old key. Fall back to routine+date strictly when
        # exactly one such row exists, so we never guess among duplicates.
        legacy = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.source_routine_id == routine_id)
            .where(Meal.meal_date == occ_date)
        ).all()
        if len(legacy) == 1:
            logged = legacy[0]

    if logged is not None:
        # The occurrence is already a concrete logged meal — edit only it,
        # never the base routine template (rule F).
        if body.skipped:
            db.exec(_sm_delete(MealItem).where(MealItem.meal_id == logged.id))
            db.flush()
            db.delete(logged)
            # Record the skip so the now-deleted occurrence can't silently be
            # re-logged later by a stale client request.
            upsert_routine_exception(
                db,
                user_id=current_user.id,
                routine_id=routine_id,
                occ_date=occ_date,
                occurrence_key=occ_key,
                skipped=True,
            )
            db.commit()
            _refresh(db, current_user.id, occ_date)
            return {"target": "log", "meal_id": None, "skipped": True}
        if body.name:
            logged.name = body.name
        if body.override_time is not None:
            logged.consumed_at = _combine_date_time(occ_date, body.override_time) if body.override_time else None
        if body.items is not None:
            db.exec(_sm_delete(MealItem).where(MealItem.meal_id == logged.id))
            db.flush()
            _clone_items_into_meal(db, current_user.id, logged.id, body.items)
        logged.updated_at = datetime.now(timezone.utc)
        logged.version = int(getattr(logged, "version", 1) or 1) + 1
        db.add(logged)
        db.flush()
        from app.routers.meals import _sync_updated_meal_day_state
        _sync_updated_meal_day_state(db, current_user.id, logged)
        db.commit()
        _refresh(db, current_user.id, occ_date)
        return {"target": "log", "meal_id": logged.id, "skipped": False}

    # Not logged yet → write/replace the per-date exception (rule F).
    payload = None
    if body.name is not None or body.items is not None:
        payload = {"name": body.name, "items": body.items}
    exc = upsert_routine_exception(
        db,
        user_id=current_user.id,
        routine_id=routine_id,
        occ_date=occ_date,
        occurrence_key=occ_key,
        override_time=body.override_time,
        skipped=body.skipped,
        edited_payload=payload,
    )
    db.commit()
    db.refresh(exc)
    return {"target": "exception", **exc.model_dump()}
