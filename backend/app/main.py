import os
from datetime import datetime, timezone
from collections.abc import Mapping
from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlmodel import Session, select
from starlette.middleware.base import BaseHTTPMiddleware

from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.cors import resolve_cors_config
from app.database import create_db_and_tables, engine
from app.limiter import limiter
from app.logging_setup import configure_logging, get_logger, new_request_id, set_request_context
from app.routers import auth, profile, workouts, meals, meta, ai, coach, recommendations, saved_meals, meal_routines, supplements, sleep, health as health_router, lifestyle as lifestyle_router, readiness as readiness_router, recovery as recovery_router, social, trainers, plan_weeks, gear as gear_router, telemetry, foods, workout_templates, manual_mode, watch as watch_router, imports as imports_router, insights as insights_router, admin as admin_router, billing as billing_router, sun_exposure as sun_exposure_router, context_insights as context_insights_router, goal_scores as goal_scores_router, streaks as streaks_router, integrations as integrations_router

# Install JSON logging first so every subsequent log line is structured.
configure_logging()
logger = get_logger("app.main")

# Register the HEIF/HEIC opener with Pillow at startup. iOS Photos
# defaults to HEIC since iOS 11; without this, library uploads (body
# scan, food photo, equipment scan, supplement scan, form photo) that
# go through `_fix_image_mime` returned 400 because Pillow couldn't
# decode the bytes for transcoding to JPEG. Both packages are pinned
# in requirements.txt; the import guard keeps the app bootable in dev
# environments where the wheel hasn't been installed yet.
try:
    import pillow_heif  # type: ignore[import-not-found]
    pillow_heif.register_heif_opener()
    logger.info("pillow_heif_registered")
except Exception as _heif_err:  # noqa: BLE001
    logger.warning("pillow_heif_unavailable", extra={"err": str(_heif_err)})

app = FastAPI(title="Thallo API", version="0.1.0")

# CORS is read from env so staging / prod can differ. `CORS_ORIGINS` is a
# comma-separated list. Dev falls back to wildcard. Production defaults to
# no browser origins unless explicit origins are configured; native apps do
# not rely on CORS.
_cors_config = resolve_cors_config()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_config.allow_origins,
    allow_credentials=_cors_config.allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)
if _cors_config.allow_origins == ["*"]:
    logger.warning("cors_wildcard_in_use", extra={"hint": "dev only; set CORS_ORIGINS for browser clients"})
elif _cors_config.is_production and not _cors_config.allow_origins:
    logger.info("cors_disabled_for_browser_origins", extra={"hint": "native-app-only production mode"})


class _RequestIdMiddleware(BaseHTTPMiddleware):
    """Attach a short request ID to every request. Caller can override via
    `X-Request-ID` header (useful for client-side correlation); otherwise
    we generate a fresh one. The ID lands in every log line via
    logging_setup's contextvar and in the response header."""

    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("X-Request-ID")
        rid = incoming or new_request_id()
        set_request_context(request_id=rid)
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        return response


class _SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Standard defensive response headers. Harmless for the iOS client,
    meaningful if anything (a webview, an OAuth redirect, an admin page)
    lands in a browser later. HSTS only when we believe we're on HTTPS
    — App Runner / CloudFront terminate TLS and set X-Forwarded-Proto."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        # Only advertise HSTS when we're actually fronted by HTTPS, otherwise
        # dev over http:// gets a header the browser mostly ignores anyway
        # but the signal is misleading.
        forwarded_proto = request.headers.get("X-Forwarded-Proto", "").lower()
        if forwarded_proto == "https" or request.url.scheme == "https":
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
        return response


app.add_middleware(_RequestIdMiddleware)
app.add_middleware(_SecurityHeadersMiddleware)

# Crash reporting + per-route latency budgets. No-op when sentry_sdk
# isn't installed or SENTRY_DSN isn't set — see app/observability.py.
from app.observability import init_observability  # noqa: E402
init_observability(app)

# Rate limiter — routes opt in via `@limiter.limit(...)`. Exceeded limits
# get a friendly 429 via `_rate_limit_exceeded_handler`.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


@dataclass(frozen=True)
class StartupBackgroundTasksConfig:
    purge_expired_soft_deletes: bool


def startup_background_tasks_config(
    env: Mapping[str, str] | None = None,
) -> StartupBackgroundTasksConfig:
    env = os.environ if env is None else env
    return StartupBackgroundTasksConfig(
        purge_expired_soft_deletes=env.get("ACCOUNT_HARD_DELETE_ENABLED", "1") == "1",
    )


def _cleanup_orphaned_plan_jobs() -> None:
    """Mark any `queued` or `running` plan jobs as `failed` on startup,
    and prune completed/failed rows older than 7 days.

    FastAPI BackgroundTasks run in-memory, so a container restart leaves
    `running` rows in limbo — the client polls forever. Old completed rows
    have no user-facing value; they're cheap to drop and prevent unbounded
    growth on the `plan_jobs` table.
    """
    from datetime import timedelta
    from app.models import PlanJob  # local import to avoid import cycles
    try:
        with Session(engine) as db:
            orphans = db.exec(
                select(PlanJob).where(PlanJob.status.in_(["queued", "running"]))
            ).all()
            now = datetime.now(timezone.utc)
            for job in orphans:
                job.status = "failed"
                job.error = "orphaned_on_restart"
                job.updated_at = now
                job.completed_at = now
                db.add(job)
            if orphans:
                logger.info("orphan_cleanup_done", extra={"count": len(orphans)})

            # Prune finished rows >7 days old. Keep in-flight + recent rows.
            cutoff = now - timedelta(days=7)
            stale = db.exec(
                select(PlanJob)
                .where(PlanJob.status.in_(["completed", "failed"]))
                .where(PlanJob.updated_at < cutoff)
            ).all()
            for job in stale:
                db.delete(job)
            if stale:
                logger.info("plan_jobs_pruned", extra={"count": len(stale)})

            if orphans or stale:
                db.commit()
    except Exception:
        # Never block startup on cleanup. Worst case the client times out on
        # its own. We DO want the traceback in logs so we notice real bugs.
        logger.exception("orphan_cleanup_failed")


def _purge_expired_soft_deletes():
    """Hard-delete user accounts that have been soft-deleted longer than
    the retention window. Runs as a daemon thread on startup; idempotent
    (no-op when nothing is past the window).

    Retention defaults to 30 days. Override via `ACCOUNT_HARD_DELETE_DAYS`.
    Set `ACCOUNT_HARD_DELETE_ENABLED=0` to disable while debugging."""
    import os, threading
    if os.getenv("ACCOUNT_HARD_DELETE_ENABLED", "1") != "1":
        logger.info("hard_delete_disabled", extra={"reason": "ACCOUNT_HARD_DELETE_ENABLED=0"})
        return
    retention_days = int(os.getenv("ACCOUNT_HARD_DELETE_DAYS", "30"))

    def _worker():
        try:
            from datetime import datetime, timedelta, timezone
            from sqlmodel import Session, select
            from app.database import engine
            from app.models import User
            cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
            with Session(engine) as db:
                stale = db.exec(
                    select(User)
                    .where(User.is_active == False)
                    .where(User.account_deleted_at != None)
                    .where(User.account_deleted_at < cutoff)
                ).all()
                if not stale:
                    logger.info("hard_delete_noop", extra={"retention_days": retention_days})
                    return
                deleted = 0
                for u in stale:
                    try:
                        db.delete(u)
                        deleted += 1
                    except Exception:
                        logger.exception("hard_delete_row_failed", extra={"user_id": u.id})
                if deleted:
                    db.commit()
                logger.info("hard_delete_done", extra={
                    "deleted": deleted,
                    "retention_days": retention_days,
                })
        except Exception:
            logger.exception("hard_delete_failed")

    threading.Thread(target=_worker, daemon=True, name="hard-delete-soft-deleted").start()


@app.on_event("startup")
def on_startup():
    logger.info("app_startup", extra={"version": app.version})
    create_db_and_tables()
    _cleanup_orphaned_plan_jobs()
    background_tasks = startup_background_tasks_config()
    if background_tasks.purge_expired_soft_deletes:
        _purge_expired_soft_deletes()
    else:
        logger.info("hard_delete_disabled", extra={"reason": "ACCOUNT_HARD_DELETE_ENABLED=0"})
    logger.info("app_startup_complete")


@app.on_event("shutdown")
def on_shutdown():
    """Drain the DB pool cleanly so App Runner / ECS deploy rollovers
    don't leave dangling connections that RDS has to time out on its own."""
    logger.info("app_shutdown_starting")
    try:
        engine.dispose()
    except Exception:
        logger.exception("engine_dispose_failed")
    logger.info("app_shutdown_complete")


app.include_router(auth.router)
app.include_router(profile.router)
# IMPORTANT: workout_templates registers before workouts because
# workouts.router has a catch-all `GET /workouts/{session_id}` that would
# swallow `/workouts/templates` (parsing "templates" as an int session id
# and 422'ing). Order-of-registration is match-order in FastAPI.
app.include_router(workout_templates.router)
app.include_router(workouts.router)
# IMPORTANT: saved_meals + meal_routines register before meals because
# meals.router has a catch-all `GET /meals/{meal_id}` that would swallow
# `/meals/saved` and `/meals/routines` (trying to parse them as ints and
# 422'ing). Order-of-registration is match-order in FastAPI.
app.include_router(saved_meals.router)
app.include_router(meal_routines.router)
app.include_router(meals.router)
app.include_router(foods.router)
app.include_router(billing_router.router)
app.include_router(supplements.router)
app.include_router(meta.router)
app.include_router(goal_scores_router.router)
app.include_router(ai.router)
app.include_router(coach.router)
app.include_router(recommendations.router)
app.include_router(sleep.router)
app.include_router(health_router.router)
app.include_router(lifestyle_router.router)
app.include_router(sun_exposure_router.router)
app.include_router(insights_router.router)
app.include_router(context_insights_router.router)
app.include_router(readiness_router.router)
app.include_router(recovery_router.router)
app.include_router(social.router)
app.include_router(trainers.router)
app.include_router(streaks_router.router)
app.include_router(integrations_router.router)
app.include_router(plan_weeks.router)
# Manual-mode endpoints — register after plan_weeks because the
# /plan-weeks/{id}/days/{idx}/(use-template|clear|mark-rest) paths
# extend that resource. FastAPI is happy with cross-router prefixes;
# this is just for navigability.
app.include_router(manual_mode.router)
app.include_router(watch_router.router)
app.include_router(gear_router.router)
app.include_router(imports_router.router)
app.include_router(telemetry.router)
app.include_router(admin_router.router)


@app.get("/health")
def health():
    """Liveness probe — returns 200 as long as the process is up. Used by
    App Runner / ECS to decide whether to restart the container."""
    return {"status": "ok", "version": app.version}


@app.get("/ready")
def ready():
    """Readiness probe — returns 200 only when the service can reach its
    dependencies (DB). App Runner / load balancers should wait for this
    to succeed before routing user traffic. Email status is reported but
    does not fail readiness so password-reset setup is visible during beta
    smoke checks without taking the API offline."""
    try:
        with Session(engine) as s:
            s.exec(text("SELECT 1"))
    except Exception:
        logger.exception("ready_probe_failed")
        from fastapi import HTTPException
        raise HTTPException(status_code=503, detail="database unavailable")
    from app.services.email_delivery import is_email_delivery_configured
    return {
        "ready": True,
        "dependencies": {
            "database": "ok",
            "email": "configured" if is_email_delivery_configured() else "missing",
        },
    }
