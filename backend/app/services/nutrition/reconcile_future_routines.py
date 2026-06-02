"""Reconcile forward-dated routine state against today's routines.

Run inside the backend container:

    docker exec thallo-backend python -m app.services.nutrition.reconcile_future_routines --dry-run
    docker exec thallo-backend python -m app.services.nutrition.reconcile_future_routines --apply
    docker exec thallo-backend python -m app.services.nutrition.reconcile_future_routines --apply --user-id 42

Why this exists: a meal routine is a TEMPLATE; logging an occurrence
copies its items into a Meal row at log time. If the user later edits
the routine (changes name/items, narrows days_of_week, archives it
entirely, or sets an end_date), forward-dated meals + the matching
UserDayState plan snapshots can carry stale routine content that no
longer reflects the user's current schedule.

This script walks each user's forward-dated state and prunes anything
that no longer matches the live routine set:

  Meal rows (forward-dated, `source_routine_id IS NOT NULL`):
    - Source routine archived/deleted        → delete meal + items
    - Source routine inactive                → delete meal + items
    - meal_date outside [start_date, end_date] → delete meal + items
    - days_of_week non-empty + weekday not in → delete meal + items

  UserDayState forward snapshots (day_key > today):
    - For each meal carrying `_routineId`, if the routine no longer
      matches the rules above, strip the meal entry from the snapshot
      so the plan card reflects the live schedule.

A reconciled (user, date) gets `_refresh_daily_metrics` so totals/score
re-aggregate. Dry-run by default; `--apply` commits. `--include-today`
also reconciles today's row.
"""

from __future__ import annotations

import argparse
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select

from app.database import engine
from app.models import Meal, MealItem, MealRoutine, UserDayState


log = logging.getLogger("reconcile_future_routines")


def _routine_active_for_date(routine: MealRoutine, target: date) -> bool:
    """True if the routine is supposed to fire on `target` based on its
    current schedule: active flag, start/end window, and days_of_week."""
    if not routine.active:
        return False
    if routine.start_date is not None and target < routine.start_date:
        return False
    if routine.end_date is not None and target > routine.end_date:
        return False
    dow = list(routine.days_of_week or [])
    if dow:
        # Python: Monday=0..Sunday=6; matches our schema.
        if target.weekday() not in {int(d) for d in dow if d is not None}:
            return False
    return True


def _routine_id_from_snapshot_meal(snapshot_meal: dict) -> Optional[int]:
    raw = snapshot_meal.get("_routineId") or snapshot_meal.get("routine_id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _row_age_rank(meal: Meal) -> tuple[datetime, int]:
    """Lower = older = kept. Same ordering rule as dedupe_future_meals."""
    created = getattr(meal, "created_at", None)
    if not isinstance(created, datetime):
        created = datetime.min.replace(tzinfo=timezone.utc)
    elif created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (created, int(getattr(meal, "id", 0) or 0))


def _routine_items_to_snapshot(routine: MealRoutine) -> list[dict]:
    """Map the routine's JSON items (food_name + *_g keys) into the
    snapshot-meal item shape that `applyRoutines` produces on the
    frontend (name + non-suffixed macro keys)."""
    out: list[dict] = []
    for it in (routine.items or []):
        if not isinstance(it, dict):
            continue
        snapshot_item = {
            "name": str(it.get("food_name") or it.get("name") or "Item"),
            "quantity": float(it.get("quantity", 1) or 1),
            "unit": str(it.get("unit") or "serving"),
            "calories": float(it.get("calories", 0) or 0),
            "protein": float(it.get("protein_g", it.get("protein", 0)) or 0),
            "carbs": float(it.get("carbs_g", it.get("carbs", 0)) or 0),
            "fat": float(it.get("fat_g", it.get("fat", 0)) or 0),
        }
        # Pass through optional fields verbatim if present.
        for key in ("food_id", "serving_id", "serving_grams", "micronutrients"):
            if key in it and it[key] is not None:
                snapshot_item[key] = it[key]
        out.append(snapshot_item)
    return out


def _snapshot_meal_from_routine(
    routine: MealRoutine,
    *,
    preserve: dict | None = None,
) -> dict:
    """Build the snapshot meal entry for `routine`, optionally carrying
    over volatile fields (`_loggedMealId`, `_consumedAt`, etc.) from a
    pre-existing snapshot entry. Mirrors the frontend `mealFromRoutine`
    so the backend-side rewrite produces what `applyRoutines` would."""
    items = _routine_items_to_snapshot(routine)
    totals = {
        "calories": sum(float(i.get("calories", 0) or 0) for i in items),
        "protein": sum(float(i.get("protein", 0) or 0) for i in items),
        "carbs": sum(float(i.get("carbs", 0) or 0) for i in items),
        "fat": sum(float(i.get("fat", 0) or 0) for i in items),
    }
    snapshot: dict = {
        "meal": routine.name,
        "items": items,
        "foods": [i["name"] for i in items],
        "amounts": [
            (str(i["quantity"]) if i.get("unit") == "piece"
             else f"{i['quantity']} {i.get('unit', 'serving')}")
            for i in items
        ],
        "calories": totals["calories"],
        "protein": totals["protein"],
        "carbs": totals["carbs"],
        "fat": totals["fat"],
        "isRoutine": True,
        "_routineId": int(routine.id),
        "source_routine_id": int(routine.id),
    }
    if preserve:
        # Keep fields that represent per-day, per-instance state — NOT the
        # routine's content. _loggedMealId is the canonical "did I log this"
        # marker; _consumedAt is the time-of-day stamp; _clientMealKey is
        # the slot identity. None of these should be overwritten by the
        # routine refresh.
        for key in ("_loggedMealId", "logged_meal_id", "_consumedAt",
                    "_clientMealKey", "client_meal_key", "_localId"):
            if key in preserve and preserve[key] is not None:
                snapshot[key] = preserve[key]
    return snapshot


def _snapshot_meal_matches(a: dict, b: dict) -> bool:
    """Deep-compare two snapshot meals for the fields the reconcile
    cares about, ignoring volatile per-instance metadata. Used to
    decide whether a rewrite is a no-op (skip the `dirty` flag)."""
    fields = ("meal", "calories", "protein", "carbs", "fat", "isRoutine",
              "_routineId", "source_routine_id")
    for f in fields:
        if a.get(f) != b.get(f):
            return False
    if (a.get("items") or []) != (b.get("items") or []):
        return False
    return True


def reconcile_future_routines(
    db: Session,
    *,
    cutoff: date,
    user_id: int | None = None,
    apply: bool = False,
) -> dict:
    """Find + (optionally) remove forward-dated routine-backed Meal rows
    and UserDayState snapshot meals that no longer match the live
    routine set. Returns a summary dict."""

    # ── Load routines once, keyed by id, scoped to the user(s) we touch.
    routines_q = select(MealRoutine)
    if user_id is not None:
        routines_q = routines_q.where(MealRoutine.user_id == user_id)
    routines_by_id: dict[int, MealRoutine] = {
        int(r.id): r for r in db.exec(routines_q).all() if r.id is not None
    }

    # ── Pass 1: Forward-dated Meal rows that came from a routine. ─────
    meals_q = (
        select(Meal)
        .where(Meal.meal_date >= cutoff)
        .where(Meal.source_routine_id.is_not(None))
    )
    if user_id is not None:
        meals_q = meals_q.where(Meal.user_id == user_id)
    meals: list[Meal] = list(db.exec(meals_q).all())

    meal_orphans: list[tuple[Meal, str]] = []  # (meal, reason)
    for meal in meals:
        rid = int(meal.source_routine_id or 0)
        routine = routines_by_id.get(rid)
        if routine is None:
            meal_orphans.append((meal, "routine_missing"))
            continue
        if int(routine.user_id) != int(meal.user_id):
            # Cross-user contamination would be a bigger bug; skip & log,
            # but never delete another user's row from this script.
            log.warning(
                "skipping meal id=%s — source_routine_id=%s belongs to user=%s, meal user=%s",
                meal.id, rid, routine.user_id, meal.user_id,
            )
            continue
        if not _routine_active_for_date(routine, meal.meal_date):
            meal_orphans.append((meal, "routine_inactive_for_date"))

    affected_dates: set[tuple[int, date]] = set()
    deleted_meal_ids: list[int] = []
    if apply and meal_orphans:
        for meal, reason in meal_orphans:
            log.info(
                "deleting meal id=%s user=%s date=%s routine=%s reason=%s",
                meal.id, meal.user_id, meal.meal_date, meal.source_routine_id, reason,
            )
            for item in db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all():
                db.delete(item)
            deleted_meal_ids.append(int(meal.id))
            affected_dates.add((int(meal.user_id), meal.meal_date))
            db.delete(meal)
        db.commit()

    # ── Pass 1b: Dedup Meal rows that share (user, date, routine). ────
    # The orphan pass above only catches rows whose routine is gone or
    # off-schedule. If the SAME live routine has multiple log rows on
    # the same future date (most often from a buggy logging path or a
    # pre-idempotency migration), they pass the orphan filter — but the
    # user still sees a duplicate. Dedup keeps the OLDEST row and
    # deletes the rest, matching `dedupe_future_meals`' tie-breaker so
    # the two scripts can be re-run in any order.
    orphan_ids = {int(m.id) for m, _ in meal_orphans}
    routine_keyed: dict[tuple[int, date, int], list[Meal]] = defaultdict(list)
    for meal in meals:
        if meal.source_routine_id is None:
            continue
        if int(meal.id or 0) in orphan_ids:
            continue
        routine_keyed[(int(meal.user_id), meal.meal_date, int(meal.source_routine_id))].append(meal)

    routine_duplicate_ids: list[int] = []
    for key, group in routine_keyed.items():
        if len(group) < 2:
            continue
        group.sort(key=_row_age_rank)
        keeper = group[0]
        for dup in group[1:]:
            log.info(
                "deduping routine meal id=%s user=%s date=%s routine=%s — keeping older id=%s",
                dup.id, dup.user_id, dup.meal_date, dup.source_routine_id, keeper.id,
            )
            routine_duplicate_ids.append(int(dup.id))
            if apply:
                for item in db.exec(select(MealItem).where(MealItem.meal_id == dup.id)).all():
                    db.delete(item)
                affected_dates.add((int(dup.user_id), dup.meal_date))
                db.delete(dup)
    if apply and routine_duplicate_ids:
        db.commit()

    # ── Pass 2: UserDayState forward snapshots. ───────────────────────
    state_q = (
        select(UserDayState)
        .where(UserDayState.day_key >= cutoff)
    )
    if user_id is not None:
        state_q = state_q.where(UserDayState.user_id == user_id)
    states: list[UserDayState] = list(db.exec(state_q).all())

    snapshot_meals_stripped = 0           # removed (orphan: no routine / off-schedule)
    snapshot_meals_duplicate_stripped = 0 # removed (duplicate _routineId on same day)
    snapshot_meals_resynced = 0           # content rewritten to match live routine
    states_touched = 0
    for state in states:
        plan = state.nutrition_plan
        if not isinstance(plan, dict):
            continue
        existing = plan.get("meals")
        if not isinstance(existing, list) or not existing:
            continue
        kept: list = []
        any_changed = False
        seen_routine_ids: set[int] = set()
        for snapshot_meal in existing:
            if not isinstance(snapshot_meal, dict):
                kept.append(snapshot_meal)
                continue
            rid = _routine_id_from_snapshot_meal(snapshot_meal)
            if rid is None:
                kept.append(snapshot_meal)
                continue
            routine = routines_by_id.get(rid)
            if routine is None or int(routine.user_id) != int(state.user_id):
                log.info(
                    "stripping snapshot meal user=%s date=%s routine=%s name=%r reason=routine_missing",
                    state.user_id, state.day_key, rid, snapshot_meal.get("meal") or snapshot_meal.get("name"),
                )
                snapshot_meals_stripped += 1
                any_changed = True
                continue
            if not _routine_active_for_date(routine, state.day_key):
                log.info(
                    "stripping snapshot meal user=%s date=%s routine=%s name=%r reason=routine_inactive_for_date",
                    state.user_id, state.day_key, rid, snapshot_meal.get("meal") or snapshot_meal.get("name"),
                )
                snapshot_meals_stripped += 1
                any_changed = True
                continue
            if rid in seen_routine_ids:
                # Two snapshot entries for the same routine on the same
                # day — keep the first, drop the rest. "Future days should
                # match today's routines EXACTLY" means at most one
                # materialization per (date, routine).
                log.info(
                    "stripping duplicate routine snapshot user=%s date=%s routine=%s name=%r",
                    state.user_id, state.day_key, rid, snapshot_meal.get("meal") or snapshot_meal.get("name"),
                )
                snapshot_meals_duplicate_stripped += 1
                any_changed = True
                continue
            seen_routine_ids.add(rid)
            # Rewrite snapshot content from the LIVE routine (name, items,
            # macros) so an edited routine doesn't leave stale copies on
            # forward days. Preserve per-instance fields (_loggedMealId,
            # _consumedAt) so the dedup pass above doesn't fight us.
            refreshed = _snapshot_meal_from_routine(routine, preserve=snapshot_meal)
            if not _snapshot_meal_matches(refreshed, snapshot_meal):
                snapshot_meals_resynced += 1
                any_changed = True
            kept.append(refreshed)
        if any_changed:
            states_touched += 1
            if apply:
                plan = dict(plan)
                plan["meals"] = kept
                state.nutrition_plan = plan
                db.add(state)
                affected_dates.add((int(state.user_id), state.day_key))
    if apply and states_touched:
        db.commit()

    # ── Refresh metrics for every affected (user, date). ──────────────
    if apply and affected_dates:
        from app.routers.meals import _refresh_daily_metrics
        for uid, d in affected_dates:
            try:
                _refresh_daily_metrics(db, uid, d, force=True)
            except Exception:
                log.exception("metrics refresh failed user=%s date=%s", uid, d)
        try:
            db.commit()
        except Exception:
            log.exception("metrics commit failed")
            db.rollback()

    return {
        "cutoff": cutoff.isoformat(),
        "orphan_meals_found": len(meal_orphans),
        "orphan_meals_deleted": len(deleted_meal_ids) if apply else 0,
        "duplicate_meals_found": len(routine_duplicate_ids),
        "duplicate_meals_deleted": len(routine_duplicate_ids) if apply else 0,
        "snapshot_meals_stripped": snapshot_meals_stripped,
        "snapshot_meals_duplicate_stripped": snapshot_meals_duplicate_stripped,
        "snapshot_meals_resynced": snapshot_meals_resynced,
        "user_day_states_touched": states_touched if apply else 0,
        "affected_dates": len(affected_dates),
        "applied": apply,
    }


def _main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Reconcile forward-dated routine state.")
    parser.add_argument("--apply", action="store_true", help="Actually delete/strip (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Force dry-run.")
    parser.add_argument("--user-id", type=int, default=None, help="Scope to one user_id.")
    parser.add_argument(
        "--include-today",
        action="store_true",
        help="Include today's row in the reconcile (default: strictly future days).",
    )
    args = parser.parse_args()
    if args.dry_run and args.apply:
        parser.error("--dry-run and --apply are mutually exclusive")
    apply = bool(args.apply)
    cutoff = date.today() if args.include_today else (date.today() + timedelta(days=1))

    with Session(engine) as db:
        summary = reconcile_future_routines(db, cutoff=cutoff, user_id=args.user_id, apply=apply)
    log.info("summary: %s", summary)


if __name__ == "__main__":
    _main()
