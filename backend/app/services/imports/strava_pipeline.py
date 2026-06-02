"""Strava activity backfill orchestrator.

Different shape from MFP/Strong since there's no file upload — we
paginate through `GET /athlete/activities` after the user has
connected via OAuth. The backfill is idempotent on the Strava
activity ID, so re-running it just picks up new activities.

Public surface:
    run_strava_backfill(session, user_id, days=180) → ImportBatch
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app.models import (
    ImportBatch, IntegrationCredential, WorkoutCompletion,
)
from .strava_client import (
    ensure_valid_token, fetch_activities_page, get_user_credential,
)
from .strava_mapper import map_strava_activities


def _activity_hash(user_id: int, external_id: str) -> str:
    return hashlib.sha256(
        f"{user_id}|strava|{external_id}".encode("utf-8")
    ).hexdigest()


def run_strava_backfill(
    session: Session,
    user_id: int,
    days: int = 180,
    user_age: int | None = None,
) -> ImportBatch:
    """Pull the user's last N days of Strava activities into Thallo
    WorkoutCompletion rows. Pagination loop terminates when a page
    returns fewer activities than the per-page limit."""
    now = datetime.now(timezone.utc)
    batch = ImportBatch(
        user_id=user_id,
        source="strava",
        data_type="workouts",
        status="processing",
        created_at=now,
        updated_at=now,
    )
    session.add(batch)
    session.commit()
    session.refresh(batch)

    cred = get_user_credential(session, user_id, "strava")
    if cred is None or cred.status != "active":
        batch.status = "failed"
        batch.errors = [{"message": "no active Strava connection"}]
        batch.completed_at = datetime.now(timezone.utc)
        batch.updated_at = batch.completed_at
        session.add(batch)
        session.commit()
        session.refresh(batch)
        return batch

    try:
        access_token = ensure_valid_token(session, cred)

        after_ts = int((now - timedelta(days=days)).timestamp())
        all_activities: list[dict] = []
        page = 1
        per_page = 100
        # Cap pagination at 50 pages = 5,000 activities. Strava's
        # per-app rate limit is 100 reqs / 15 min, 1,000 / day —
        # comfortably under for normal users.
        for _ in range(50):
            page_data = fetch_activities_page(
                access_token, page=page, per_page=per_page, after_ts=after_ts,
            )
            if not page_data:
                break
            all_activities.extend(page_data)
            if len(page_data) < per_page:
                break
            page += 1

        mapped = map_strava_activities(all_activities, age=user_age)
        batch.total_rows = len(all_activities)

        existing = {
            h for (h,) in session.exec(
                select(WorkoutCompletion.import_hash).where(
                    WorkoutCompletion.user_id == user_id,
                    WorkoutCompletion.import_hash.is_not(None),
                )
            ).all()
            if h is not None
        }

        matched_count = 0
        for m in mapped:
            row_hash = _activity_hash(user_id, m.external_id)
            if row_hash in existing:
                continue
            existing.add(row_hash)

            session.add(WorkoutCompletion(
                user_id=user_id,
                workout_date=m.workout_date,
                focus_label=m.focus_label,
                duration_seconds=m.duration_seconds,
                source_context="import_strava",
                activity_category=m.activity_category,
                activity_subtype=m.activity_subtype,
                activity_source="strava",
                cardio_style=m.cardio_style,
                distance_miles=m.distance_miles,
                calories_burned=m.calories_burned,
                activity_details=m.activity_details,
                route_coords=m.route_coords,
                hr_summary={
                    "avgBpm": m.avg_hr_bpm,
                    "maxBpm": m.max_hr_bpm,
                } if m.avg_hr_bpm or m.max_hr_bpm else None,
                started_at=m.started_at,
                ended_at=m.ended_at,
                external_source_id=m.external_id,
                import_source="strava",
                import_batch_id=batch.id,
                import_hash=row_hash,
                completed_at=now,
            ))
            matched_count += 1

        cred.last_synced_at = datetime.now(timezone.utc)
        session.add(cred)

        batch.matched_rows = matched_count
        batch.fallback_rows = batch.total_rows - matched_count - len(mapped) + matched_count
        batch.status = "complete"
        batch.completed_at = datetime.now(timezone.utc)
        batch.updated_at = batch.completed_at
        session.add(batch)
        session.commit()
        session.refresh(batch)
        return batch
    except Exception as exc:
        session.rollback()
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
