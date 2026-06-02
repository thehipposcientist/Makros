"""One-shot dedupe for forward-dated meal logs.

Run inside the backend container:

    docker exec thallo-backend python -m app.services.nutrition.dedupe_future_meals --dry-run
    docker exec thallo-backend python -m app.services.nutrition.dedupe_future_meals --apply
    docker exec thallo-backend python -m app.services.nutrition.dedupe_future_meals --apply --user-id 42
    docker exec thallo-backend python -m app.services.nutrition.dedupe_future_meals --apply --include-today

Why this exists: the application-layer idempotency added in `bbf852a9`
prevents NEW duplicates, but a few users still carried duplicate rows
inserted by older builds before the unique index was in place. This
script is a safe, idempotent cleanup for that legacy state — and a
break-glass tool for any future regression where duplicates slip
through. It only ever touches meals dated TODAY or later (so it can't
silently rewrite logged history).

Dedup key: (user_id, meal_date, normalized_meal_type, normalized_name,
items_signature). When multiple rows match, we keep the OLDEST row
(lowest id, lowest created_at). Deletion is wrapped in the same
`_sync_updated_meal_day_state` helper the favorite/unfavorite path uses
so the day-state snapshot reconciles with the cleaned-up logs.
"""

from __future__ import annotations

import argparse
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from sqlmodel import Session, select

from app.database import engine
from app.models import Meal, MealItem
from app.services.nutrition.meal_history import (
    _meal_items_signature,
    _meal_type_name,
    _normalize_meal_text,
)


log = logging.getLogger("dedupe_future_meals")


def _group_key(meal: Meal, items: list[MealItem]) -> tuple:
    return (
        int(meal.user_id),
        meal.meal_date,
        _meal_type_name(meal),
        _normalize_meal_text(getattr(meal, "name", "")),
        _meal_items_signature(items),
    )


def _row_age_rank(meal: Meal) -> tuple[datetime, int]:
    """Lower = older = kept. Falls back to id when created_at ties."""
    created = getattr(meal, "created_at", None)
    if not isinstance(created, datetime):
        created = datetime.min.replace(tzinfo=timezone.utc)
    elif created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (created, int(getattr(meal, "id", 0) or 0))


def find_future_meal_duplicates(
    db: Session,
    *,
    cutoff: date,
    user_id: int | None = None,
) -> list[tuple[tuple, list[Meal]]]:
    """Return list of (group_key, [meals]) for groups with 2+ rows on or
    after `cutoff`. Each list is sorted oldest-first."""
    stmt = select(Meal).where(Meal.meal_date >= cutoff)
    if user_id is not None:
        stmt = stmt.where(Meal.user_id == user_id)
    meals: list[Meal] = list(db.exec(stmt).all())
    if not meals:
        return []

    meal_ids = [int(m.id) for m in meals if m.id is not None]
    items_by_meal: dict[int, list[MealItem]] = defaultdict(list)
    if meal_ids:
        for item in db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all():
            items_by_meal[int(item.meal_id)].append(item)

    groups: dict[tuple, list[Meal]] = defaultdict(list)
    for meal in meals:
        items = items_by_meal.get(int(meal.id or 0), [])
        groups[_group_key(meal, items)].append(meal)

    out: list[tuple[tuple, list[Meal]]] = []
    for key, rows in groups.items():
        if len(rows) < 2:
            continue
        rows.sort(key=_row_age_rank)
        out.append((key, rows))
    return out


def dedupe_future_meals(
    db: Session,
    *,
    cutoff: date,
    user_id: int | None = None,
    apply: bool = False,
) -> dict:
    """Return a summary dict. If `apply=True`, delete the duplicates AND
    sync the affected day-states. If False, just count + log."""
    groups = find_future_meal_duplicates(db, cutoff=cutoff, user_id=user_id)
    total_groups = len(groups)
    total_to_delete = sum(len(rows) - 1 for _, rows in groups)
    affected_users: set[int] = set()
    affected_dates: set[tuple[int, date]] = set()
    deleted_ids: list[int] = []

    for key, rows in groups:
        kept = rows[0]
        affected_users.add(int(kept.user_id))
        for dup in rows[1:]:
            affected_dates.add((int(dup.user_id), dup.meal_date))
            log.info(
                "duplicate found user=%s date=%s name=%r meal_type=%s "
                "keeping=%s deleting=%s",
                kept.user_id, kept.meal_date, kept.name,
                key[2], kept.id, dup.id,
            )
            if apply:
                # Delete items first to avoid FK/integrity errors. We
                # don't go through the meals.py DELETE endpoint because
                # it triggers metrics refresh per row — we batch the
                # refresh below.
                for item in db.exec(select(MealItem).where(MealItem.meal_id == dup.id)).all():
                    db.delete(item)
                deleted_ids.append(int(dup.id))
                db.delete(dup)

    if apply and deleted_ids:
        db.commit()
        # Refresh daily metrics + day-state once per affected (user, date)
        # rather than per row. Import lazily so test imports don't trigger
        # the full router-level dep graph.
        from app.routers.meals import _refresh_daily_metrics, _sync_updated_meal_day_state
        for uid, d in affected_dates:
            try:
                _refresh_daily_metrics(db, uid, d, force=True)
            except Exception:
                log.exception("metrics refresh failed user=%s date=%s", uid, d)
            # Re-sync any survivor on that date into the day-state so
            # the snapshot no longer references a deleted row's id.
            survivors = db.exec(
                select(Meal)
                .where(Meal.user_id == uid)
                .where(Meal.meal_date == d)
            ).all()
            for survivor in survivors:
                try:
                    _sync_updated_meal_day_state(db, uid, survivor)
                except Exception:
                    log.exception("day-state sync failed user=%s date=%s meal=%s", uid, d, survivor.id)
            try:
                db.commit()
            except Exception:
                log.exception("day-state commit failed user=%s date=%s", uid, d)
                db.rollback()

    return {
        "cutoff": cutoff.isoformat(),
        "duplicate_groups": total_groups,
        "rows_to_delete": total_to_delete,
        "rows_deleted": len(deleted_ids) if apply else 0,
        "affected_users": len(affected_users),
        "affected_dates": len(affected_dates),
        "applied": apply,
    }


def _main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Dedupe forward-dated duplicate meal logs.")
    parser.add_argument("--apply", action="store_true", help="Actually delete duplicates (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Force dry-run (default if --apply not set).")
    parser.add_argument("--user-id", type=int, default=None, help="Scope to one user_id (default: all users).")
    parser.add_argument(
        "--include-today",
        action="store_true",
        help="Include today's meals in the dedupe (default: strictly future days only).",
    )
    args = parser.parse_args()

    if args.dry_run and args.apply:
        parser.error("--dry-run and --apply are mutually exclusive")
    apply = bool(args.apply)
    cutoff = date.today() if args.include_today else (date.today() + timedelta(days=1))

    with Session(engine) as db:
        summary = dedupe_future_meals(db, cutoff=cutoff, user_id=args.user_id, apply=apply)
    log.info("summary: %s", summary)


if __name__ == "__main__":
    _main()
