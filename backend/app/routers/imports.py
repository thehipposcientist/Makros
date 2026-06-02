"""Data-import upload + status endpoints.

One source per upload route to keep the multipart handling
straightforward. Each route owns its own size cap and source-specific
quirks (ZIP vs CSV detection for MFP, etc.). Strong and Strava follow
in their own routes as they ship.

POST /imports/myfitnesspal/upload  — multipart file → batch row
GET  /imports/{batch_id}/status    — poll for progress + counters
GET  /imports/                     — list user's recent imports
DELETE /imports/{batch_id}         — rollback all rows from this batch
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import ImportBatch, IntegrationCredential, User
from app.services.imports.mfp_pipeline import (
    rollback_import,
    run_mfp_import,
)
from app.services.imports.fitnotes_pipeline import (
    build_fitnotes_preview,
    run_fitnotes_import,
)
from app.services.imports.strava_client import (
    build_authorize_url, exchange_code_for_tokens, generate_state_nonce,
    save_tokens_after_exchange,
)
from app.services.imports.strava_pipeline import run_strava_backfill
from app.services.imports.strong_pipeline import (
    build_strong_preview,
    rollback_strong_import,
    run_strong_import,
)


# State nonces — held in-process for the OAuth handshake window. Each
# state is good for one callback exchange. Restart wipes them, which
# is fine since users will just be told to reconnect. Per-user TTL
# also prevents state reuse.
_PENDING_OAUTH_STATES: dict[str, tuple[int, float]] = {}
_STATE_TTL_SECONDS = 600.0  # 10 min — Strava's grant flow window.


def _purge_expired_states() -> None:
    import time
    now = time.time()
    expired = [k for k, (_uid, ts) in _PENDING_OAUTH_STATES.items() if now - ts > _STATE_TTL_SECONDS]
    for k in expired:
        _PENDING_OAUTH_STATES.pop(k, None)

router = APIRouter(prefix="/imports", tags=["imports"])


# Hard caps so a malformed upload can't OOM the worker. 25 MB covers
# realistic MFP exports — a 5-year heavy-logger GDPR ZIP runs about
# 8 MB compressed.
_MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _serialize_batch(b: ImportBatch) -> dict:
    return {
        "id": b.id,
        "source": b.source,
        "data_type": b.data_type,
        "filename": b.filename,
        "status": b.status,
        "total_rows": b.total_rows,
        "matched_rows": b.matched_rows,
        "ai_matched_rows": b.ai_matched_rows,
        "fallback_rows": b.fallback_rows,
        "skipped_rows": b.skipped_rows,
        "error_rows": b.error_rows,
        "errors": b.errors or [],
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "updated_at": b.updated_at.isoformat() if b.updated_at else None,
        "completed_at": b.completed_at.isoformat() if b.completed_at else None,
    }


async def _read_upload(file: UploadFile) -> bytes:
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="empty file")
    if len(file_bytes) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large (max {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
        )
    return file_bytes


@router.post("/myfitnesspal/upload")
async def upload_mfp(
    file: UploadFile = File(...),
    use_usda: bool = Query(default=True),
    use_ai_metadata: bool = Query(default=False),
    max_usda_lookups: int = Query(default=50, ge=0, le=250),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Upload a MyFitnessPal CSV or GDPR ZIP. Returns the batch row
    with final counters."""
    file_bytes = await _read_upload(file)
    batch = run_mfp_import(
        session=session,
        user_id=current_user.id,
        file_bytes=file_bytes,
        filename=file.filename,
        use_usda=use_usda,
        use_ai_metadata=use_ai_metadata,
        max_usda_lookups=max_usda_lookups,
    )
    return _serialize_batch(batch)


@router.post("/strong/preview")
async def preview_strong(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Parse + match a Strong CSV without writing anything. Returns a
    per-session preview so the client can show the user what's about to
    be imported and let them confirm or cancel."""
    file_bytes = await _read_upload(file)
    return build_strong_preview(
        session=session,
        user_id=current_user.id,
        file_bytes=file_bytes,
    )


@router.post("/strong/upload")
async def upload_strong(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Upload a Strong workout-history CSV. Creates one
    WorkoutSession + WorkoutCompletion per (date, workout_name)
    grouping, with ExerciseSet rows for each logged set. Weights are
    normalized to lbs regardless of the user's Strong unit setting."""
    file_bytes = await _read_upload(file)
    batch = run_strong_import(
        session=session,
        user_id=current_user.id,
        file_bytes=file_bytes,
        filename=file.filename,
    )
    return _serialize_batch(batch)


@router.post("/fitnotes/preview")
async def preview_fitnotes(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Parse + match a FitNotes workout CSV without writing anything.
    FitNotes exports do not carry stable workout names, so rows are
    previewed as one session per workout date."""
    file_bytes = await _read_upload(file)
    return build_fitnotes_preview(
        session=session,
        user_id=current_user.id,
        file_bytes=file_bytes,
    )


@router.post("/fitnotes/upload")
async def upload_fitnotes(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Upload a FitNotes workout-history CSV. Creates one
    WorkoutSession + WorkoutCompletion per export date, with set rows
    for each logged exercise set."""
    file_bytes = await _read_upload(file)
    batch = run_fitnotes_import(
        session=session,
        user_id=current_user.id,
        file_bytes=file_bytes,
        filename=file.filename,
    )
    return _serialize_batch(batch)


@router.get("/strava/authorize")
def strava_authorize(
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return the URL the client should open to start the Strava OAuth
    grant. The state nonce protects against CSRF — it's stored in-
    process and verified on callback."""
    state = generate_state_nonce()
    import time
    _purge_expired_states()
    _PENDING_OAUTH_STATES[state] = (current_user.id, time.time())

    url = build_authorize_url(state)
    if url is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Strava OAuth not configured. Set STRAVA_CLIENT_ID + "
                "STRAVA_CLIENT_SECRET in the backend environment and "
                "register the callback URL at strava.com/settings/api."
            ),
        )
    return {"authorize_url": url, "state": state}


@router.get("/strava/callback")
def strava_callback(
    code: str = Query(...),
    state: str = Query(...),
    session: Session = Depends(get_session),
):
    """Strava redirects here with `code` after the user grants access.
    We verify the state nonce, exchange the code for tokens, persist
    the credential, and redirect into the app's deep-link.

    No auth dependency on this endpoint — the state nonce + matching
    user lookup is the security boundary. (Strava initiates the
    request; no auth header arrives.)
    """
    _purge_expired_states()
    pending = _PENDING_OAUTH_STATES.pop(state, None)
    if pending is None:
        raise HTTPException(status_code=400, detail="invalid or expired state")
    user_id, _ts = pending

    try:
        token_response = exchange_code_for_tokens(code)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"token exchange failed: {exc}")

    save_tokens_after_exchange(session, user_id, token_response)
    # Deep-link back into the app's Settings → Import screen. The
    # client knows how to surface a "connected" toast.
    return RedirectResponse(url="thallo://imports/strava?connected=1", status_code=302)


@router.post("/strava/backfill")
def strava_backfill(
    days: int = Query(180, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Pull the user's last N days of Strava activities into Thallo.
    Requires a prior /strava/authorize → /strava/callback handshake."""
    cred = session.exec(
        select(IntegrationCredential).where(
            IntegrationCredential.user_id == current_user.id,
            IntegrationCredential.provider == "strava",
        )
    ).first()
    if cred is None or cred.status != "active":
        raise HTTPException(
            status_code=409,
            detail="Strava not connected. Run /imports/strava/authorize first.",
        )
    # Pull age for cardio_style classification.
    from app.models import UserProfile
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    user_age = profile.age if profile and getattr(profile, "age", None) else None

    batch = run_strava_backfill(
        session=session,
        user_id=current_user.id,
        days=days,
        user_age=user_age,
    )
    return _serialize_batch(batch)


@router.get("/{batch_id}/status")
def get_batch_status(
    batch_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    batch = session.exec(
        select(ImportBatch).where(
            ImportBatch.id == batch_id,
            ImportBatch.user_id == current_user.id,
        )
    ).first()
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    return _serialize_batch(batch)


@router.get("/")
def list_batches(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Recent imports for this user, newest first. Caps at 50 so the
    Settings → Import screen stays bounded."""
    rows = session.exec(
        select(ImportBatch)
        .where(ImportBatch.user_id == current_user.id)
        .order_by(ImportBatch.created_at.desc())
        .limit(50)
    ).all()
    return [_serialize_batch(r) for r in rows]


@router.delete("/{batch_id}")
def delete_batch(
    batch_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """Rolls back every Meal / WorkoutCompletion row imported by this
    batch. The batch row itself stays (marked `status='rolled_back'`)
    so it's still visible in the history list.

    Dispatches to the source-specific rollback (workouts need to walk
    WorkoutSession/Exercise/Set chains; meals just need Meal + MealItem)."""
    batch = session.exec(
        select(ImportBatch).where(
            ImportBatch.id == batch_id,
            ImportBatch.user_id == current_user.id,
        )
    ).first()
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    if batch.data_type == "workouts":
        success = rollback_strong_import(session, current_user.id, batch_id)
    else:
        success = rollback_import(session, current_user.id, batch_id)
    if not success:
        raise HTTPException(status_code=404, detail="batch not found")
    return {"status": "rolled_back", "batch_id": batch_id}
