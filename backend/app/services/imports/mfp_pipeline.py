"""End-to-end MyFitnessPal import orchestrator.

Wires `mfp_parser.parse_mfp_csv` / `parse_mfp_gdpr_zip` together with
`mfp_matcher.match_mfp_row`, performs idempotent `Meal` + `MealItem`
inserts, and updates the `ImportBatch` row with per-status counters.

Synchronous. A typical MFP export is ~1,300 rows; with candidates
preloaded once the per-row work is in-memory token math + an insert,
which finishes in a few seconds for the largest exports we've seen.
If we ever need to handle multi-year multi-megabyte exports we'll move
this to a background task.

Public surface:
    run_mfp_import(session, user_id, file_bytes, filename) → ImportBatch
    rollback_import(session, user_id, batch_id) → bool
"""

from __future__ import annotations

import hashlib
import io
import os
import zipfile
from datetime import date, datetime, timezone
from typing import Callable, Iterable

from sqlmodel import Session, select

from app.enums import MealSource, MealType
from app.models import (
    ImportBatch, Meal, MealItem,
)
from app.services.nutrition.added_sugar import resolve_added_sugar_g

from .mfp_matcher import (
    MatchResult, _Candidate,
    _food_candidates_from_db, match_mfp_row,
)
from .mfp_parser import (
    ParsedMealRow, ParseResult,
    parse_mfp_csv, parse_mfp_gdpr_zip,
)


# Looks like a ZIP if the first two bytes are "PK" (ZIP local file header).
def _is_zip(file_bytes: bytes) -> bool:
    return len(file_bytes) >= 4 and file_bytes[:2] == b"PK"


def _row_hash(user_id: int, row: ParsedMealRow) -> str:
    """Stable per-row identity. Re-uploading the same export must
    produce the same hashes so the partial-unique-index on
    (user_id, import_hash) blocks duplicates at the DB level."""
    parts = [
        str(user_id),
        "myfitnesspal",
        row.meal_date.isoformat(),
        row.meal_type,
        row.food_name.strip().lower(),
        # Macros included so a row edited in MFP and re-exported gets a
        # different hash (treat as a new row rather than dedupe).
        f"{row.calories or 0:.2f}",
        f"{row.protein_g or 0:.2f}",
        f"{row.carbs_g or 0:.2f}",
        f"{row.fat_g or 0:.2f}",
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _meal_type_enum(parsed: str) -> MealType:
    try:
        return MealType(parsed)
    except ValueError:
        # Parser normalizes to {breakfast, lunch, dinner, snack} but
        # if the enum gains new variants we degrade to snack rather
        # than 500.
        return MealType.SNACK


def _parse_file(file_bytes: bytes) -> ParseResult:
    """Auto-detect ZIP vs CSV and call the appropriate parser."""
    if _is_zip(file_bytes):
        return parse_mfp_gdpr_zip(file_bytes)
    return parse_mfp_csv(file_bytes)


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _normalized_name_key(name: str) -> str:
    return " ".join(name.strip().lower().split())


def _build_usda_lookup(
    session: Session,
    *,
    user_id: int,
    max_lookups: int,
) -> Callable[[str], MatchResult | None] | None:
    """Return a bounded USDA lookup hook for unmatched MFP rows.

    Search results are imported into the catalog only after this pipeline
    chooses one as a normalization target. MFP's logged macros still remain
    authoritative for the MealItem row.
    """
    if max_lookups <= 0:
        return None

    try:
        from app.food_service import upsert_catalog_food_from_search_item
        from app.services.usda_fdc import search_foods as usda_search
    except Exception:
        return None

    cache: dict[str, MatchResult | None] = {}
    lookup_count = 0

    def lookup(food_name: str) -> MatchResult | None:
        nonlocal lookup_count
        key = _normalized_name_key(food_name)
        if not key:
            return None
        if key in cache:
            return cache[key]
        if lookup_count >= max_lookups:
            cache[key] = None
            return None
        lookup_count += 1

        results = usda_search(food_name, max_results=1)
        if not results:
            cache[key] = None
            return None

        imported = upsert_catalog_food_from_search_item(session, results[0], user_id=user_id)
        if imported is None or imported.id is None:
            cache[key] = None
            return None

        match = MatchResult(
            food_id=imported.id,
            food_name=imported.name,
            confidence="usda",
            calories=None,
            protein_g=None,
            carbs_g=None,
            fat_g=None,
            note=f"USDA normalized from MFP food {food_name!r}",
        )
        cache[key] = match
        return match

    return lookup


def _refresh_imported_dates(
    session: Session,
    *,
    user_id: int,
    dates: Iterable[date],
    allow_ai_metadata: bool,
) -> None:
    """Best-effort recompute of derived nutrition metrics after import."""
    try:
        from app.services.nutrition.gut_health import compute_daily_metrics
        from app.services.readiness.compute import invalidate_readiness_cache
    except Exception:
        return

    for meal_date in sorted(set(dates)):
        try:
            compute_daily_metrics(
                session,
                user_id=user_id,
                metric_date=meal_date,
                allow_ai=allow_ai_metadata,
            )
        except Exception:
            session.rollback()
    try:
        invalidate_readiness_cache(user_id)
    except Exception:
        pass


def run_mfp_import(
    session: Session,
    user_id: int,
    file_bytes: bytes,
    filename: str | None = None,
    *,
    use_usda: bool = True,
    use_ai_metadata: bool = False,
    max_usda_lookups: int | None = None,
) -> ImportBatch:
    """Parse + match + insert. Returns the persisted ImportBatch with
    final counters. Always returns a batch row, even on parse failure,
    so the client has a handle for the error-review UI."""
    now = datetime.now(timezone.utc)
    batch = ImportBatch(
        user_id=user_id,
        source="myfitnesspal",
        data_type="meals",
        filename=filename,
        status="processing",
        created_at=now,
        updated_at=now,
    )
    session.add(batch)
    session.commit()
    session.refresh(batch)

    try:
        parse_result = _parse_file(file_bytes)

        # Parse-level errors are recorded but don't abort — we still
        # try to import any rows that did parse successfully.
        batch.errors = [{"message": e} for e in parse_result.errors]
        batch.total_rows = len(parse_result.rows) + parse_result.skipped_count + len(parse_result.errors)
        batch.skipped_rows = parse_result.skipped_count
        batch.error_rows = len(parse_result.errors)

        if not parse_result.rows:
            batch.status = "failed" if parse_result.errors else "complete"
            batch.completed_at = datetime.now(timezone.utc)
            batch.updated_at = batch.completed_at
            session.add(batch)
            session.commit()
            session.refresh(batch)
            return batch

        # Preload candidates once — they're reused across every row.
        candidates = _food_candidates_from_db(session, user_id)
        usda_lookup_fn = _build_usda_lookup(
            session,
            user_id=user_id,
            max_lookups=max_usda_lookups
            if max_usda_lookups is not None
            else _env_int("MFP_IMPORT_MAX_USDA_LOOKUPS", 50),
        ) if use_usda else None

        # Pull existing hashes for this user up front so we can dedupe
        # in-memory without per-row SELECTs. The partial unique index
        # is the authoritative defense, but checking first avoids
        # IntegrityError-then-rollback per duplicate row.
        existing_hashes = {
            h for (h,) in session.exec(
                select(Meal.import_hash).where(
                    Meal.user_id == user_id,
                    Meal.import_hash.is_not(None),
                )
            ).all()
            if h is not None
        }

        matched_count = 0
        ai_matched_count = 0
        fallback_count = 0
        touched_dates: set[date] = set()
        for parsed_row in parse_result.rows:
            row_hash = _row_hash(user_id, parsed_row)
            if row_hash in existing_hashes:
                # Already imported on a previous run — silently skip.
                continue
            existing_hashes.add(row_hash)

            match = match_mfp_row(
                parsed_row,
                session=session,
                user_id=user_id,
                candidates=candidates,
                usda_lookup_fn=usda_lookup_fn,
            )
            calories = parsed_row.calories if parsed_row.calories is not None else match.calories
            protein_g = parsed_row.protein_g if parsed_row.protein_g is not None else match.protein_g
            carbs_g = parsed_row.carbs_g if parsed_row.carbs_g is not None else match.carbs_g
            fat_g = parsed_row.fat_g if parsed_row.fat_g is not None else match.fat_g
            if match.confidence in ("exact", "alias", "fuzzy"):
                matched_count += 1
            elif match.confidence in ("usda", "ai"):
                ai_matched_count += 1
            else:
                fallback_count += 1

            meal = Meal(
                user_id=user_id,
                meal_date=parsed_row.meal_date,
                meal_type=_meal_type_enum(parsed_row.meal_type),
                name=match.food_name,
                source=MealSource.LOGGED,
                notes=parsed_row.note,
                import_source="myfitnesspal",
                import_batch_id=batch.id,
                import_hash=row_hash,
                created_at=now,
            )
            session.add(meal)
            session.flush()  # populate meal.id
            touched_dates.add(parsed_row.meal_date)

            added_sugar_g = resolve_added_sugar_g(
                match.food_name,
                sugar_g=parsed_row.sugar_g,
            )
            session.add(MealItem(
                meal_id=meal.id,
                food_name=match.food_name,
                food_id=match.food_id,
                quantity=1.0,
                unit=(parsed_row.quantity_text or "serving"),
                calories=calories or 0.0,
                protein_g=protein_g or 0.0,
                carbs_g=carbs_g or 0.0,
                fat_g=fat_g or 0.0,
                saturated_fat_g=parsed_row.saturated_fat_g,
                cholesterol_mg=parsed_row.cholesterol_mg,
                sodium_mg=parsed_row.sodium_mg,
                fiber_g=parsed_row.fiber_g,
                sugar_g=parsed_row.sugar_g,
                added_sugar_g=added_sugar_g,
            ))

        batch.matched_rows = matched_count
        batch.ai_matched_rows = ai_matched_count
        batch.fallback_rows = fallback_count
        batch.status = "complete"
        batch.completed_at = datetime.now(timezone.utc)
        batch.updated_at = batch.completed_at
        session.add(batch)
        session.commit()
        _refresh_imported_dates(
            session,
            user_id=user_id,
            dates=touched_dates,
            allow_ai_metadata=use_ai_metadata,
        )
        session.refresh(batch)
        return batch
    except Exception as exc:
        # Roll back any partial inserts so the user can retry cleanly.
        session.rollback()
        # Re-fetch the batch row since rollback dropped our pending
        # in-flight reference.
        batch = session.exec(
            select(ImportBatch).where(ImportBatch.id == batch.id)
        ).first()
        if batch is not None:
            batch.status = "failed"
            batch.errors = [*(batch.errors or []), {"message": f"orchestrator: {exc!s}"}]
            batch.completed_at = datetime.now(timezone.utc)
            batch.updated_at = batch.completed_at
            session.add(batch)
            session.commit()
            session.refresh(batch)
        raise


def rollback_import(session: Session, user_id: int, batch_id: int) -> bool:
    """Delete every Meal (and cascading MealItem) inserted by this
    batch. Used when a user wants to undo a bad import.

    Returns True when the batch was found + rolled back, False when
    the batch doesn't exist or belongs to another user."""
    batch = session.exec(
        select(ImportBatch).where(
            ImportBatch.id == batch_id,
            ImportBatch.user_id == user_id,
        )
    ).first()
    if not batch:
        return False

    meals = session.exec(
        select(Meal).where(
            Meal.user_id == user_id,
            Meal.import_batch_id == batch_id,
        )
    ).all()
    for m in meals:
        items = session.exec(
            select(MealItem).where(MealItem.meal_id == m.id)
        ).all()
        for mi in items:
            session.delete(mi)
        session.delete(m)

    batch.status = "rolled_back"
    batch.updated_at = datetime.now(timezone.utc)
    session.add(batch)
    session.commit()
    return True
