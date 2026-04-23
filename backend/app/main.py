import os
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlmodel import Session, select
from starlette.middleware.base import BaseHTTPMiddleware

from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.database import create_db_and_tables, engine
from app.limiter import limiter
from app.logging_setup import configure_logging, get_logger, new_request_id, set_request_context
from app.routers import auth, profile, workouts, meals, meta, ai, coach

# Install JSON logging first so every subsequent log line is structured.
configure_logging()
logger = get_logger("app.main")

app = FastAPI(title="Thallo API", version="0.1.0")

# CORS is read from env so staging / prod can differ. `CORS_ORIGINS` is a
# comma-separated list; leave it blank for dev to fall back to `*`.
_cors_raw = os.getenv("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if _cors_origins == ["*"]:
    logger.warning("cors_wildcard_in_use", extra={"hint": "set CORS_ORIGINS in prod"})


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

# Rate limiter — routes opt in via `@limiter.limit(...)`. Exceeded limits
# get a friendly 429 via `_rate_limit_exceeded_handler`.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


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


def _startup_enrich_food_micros():
    """Ensure every FoodNutrition row has the Layer 2 micronutrient
    panel present in `extra_nutrients`. Runs on server startup as a
    background thread so it never blocks boot.

    Idempotent + incremental — only enriches rows missing Layer 2
    keys. Gated by `STARTUP_ENRICH_FOODS_ENABLED=1` env var (on by
    default; set to 0 to disable during testing)."""
    import os
    if os.getenv("STARTUP_ENRICH_FOODS_ENABLED", "1") != "1":
        logger.info("food_enrichment_disabled", extra={"reason": "STARTUP_ENRICH_FOODS_ENABLED=0"})
        return
    import threading
    def _worker():
        try:
            from sqlmodel import Session, select
            from app.database import engine
            from app.models import Food, FoodNutrition
            from openai import OpenAI
            from app.routers.ai.utils import get_openai_api_key

            REQUIRED = [
                "cholesterol", "saturated_fat", "monounsaturated_fat",
                "polyunsaturated_fat", "omega_3", "omega_6",
                "potassium", "calcium", "iron", "magnesium",
                "vitamin_c", "vitamin_d", "vitamin_b12",
            ]

            with Session(engine) as db:
                rows = db.exec(select(FoodNutrition)).all()
                thin = [n for n in rows if any(k not in (n.extra_nutrients or {}) for k in REQUIRED)]
                if not thin:
                    logger.info("food_enrichment_noop", extra={"total": len(rows)})
                    return
                logger.info("food_enrichment_starting", extra={"thin": len(thin), "total": len(rows)})

            api_key = get_openai_api_key()
            if not api_key:
                logger.warning("food_enrichment_skipped_no_key")
                return
            client = OpenAI(api_key=api_key)

            # Import the enrichment helper from the script so we don't
            # duplicate the prompt + sanity-check logic.
            import sys
            sys.path.insert(0, "/app")
            try:
                from enrich_food_micros import _ai_enrich_batch, BATCH_SIZE
            except Exception:
                logger.exception("food_enrichment_import_failed")
                return

            with Session(engine) as db:
                # Re-query in this session so the bind is attached.
                rows = db.exec(select(FoodNutrition)).all()
                thin_ids = {n.food_id for n in rows if any(k not in (n.extra_nutrients or {}) for k in REQUIRED)}
                thin_foods = db.exec(select(Food).where(Food.id.in_(thin_ids))).all() if thin_ids else []
                pairs = []
                food_by_id = {f.id: f for f in thin_foods}
                nut_by_id = {n.food_id: n for n in rows if n.food_id in thin_ids}
                for fid in thin_ids:
                    if fid in food_by_id and fid in nut_by_id:
                        pairs.append((food_by_id[fid], nut_by_id[fid]))

                enriched = 0
                for start in range(0, len(pairs), BATCH_SIZE):
                    batch = pairs[start : start + BATCH_SIZE]
                    results = _ai_enrich_batch(client, batch)
                    for food, nut in batch:
                        micros = results.get(food.id)
                        if not micros:
                            continue
                        extras = dict(getattr(nut, "extra_nutrients", None) or {})
                        for k, v in micros.items():
                            if k == "fiber":
                                nut.fiber = v
                            elif k == "sugar":
                                nut.sugar = v
                            elif k == "sodium":
                                nut.sodium_mg = v
                            else:
                                extras[k] = v
                        for k in REQUIRED:
                            if k not in extras:
                                extras[k] = 0.0
                        nut.extra_nutrients = extras
                        db.add(nut)
                        enriched += 1
                    db.commit()
                logger.info("food_enrichment_done", extra={"enriched": enriched, "total": len(pairs)})
        except Exception:
            logger.exception("food_enrichment_failed")

    threading.Thread(target=_worker, daemon=True, name="enrich-food-micros").start()
    logger.info("food_enrichment_kicked_off")


def _startup_enrich_exercise_images():
    """Background: clean generic images then re-enrich from wger.de."""
    import threading
    def _worker():
        try:
            from app.seed_exercise_images import seed_exercise_images, clear_bad_images
            clear_bad_images(engine)
            seed_exercise_images(engine)
        except Exception:
            logger.exception("exercise_image_enrichment_failed")
    threading.Thread(target=_worker, daemon=True, name="enrich-exercise-images").start()


def _startup_backfill_muscle_fatigue():
    """Background: resolve muscle fatigue for existing completions that don't have it."""
    import threading
    def _worker():
        try:
            from sqlmodel import Session, select
            from app.models import WorkoutCompletion, WorkoutExercise, ExerciseSet
            from app.services.workout.activity_impact import resolve_exercise_fatigue, resolve_focus_fatigue
            from app.seed_exercises_data import SEED_EXERCISES

            seed_map = {e["name"].lower(): e for e in SEED_EXERCISES}
            with Session(engine) as db:
                rows = db.exec(
                    select(WorkoutCompletion).where(WorkoutCompletion.resolved_muscle_fatigue == None)
                ).all()
                if not rows:
                    return

                backfilled = 0
                for row in rows:
                    # Try to find structured exercise data
                    from app.models import WorkoutSession as WS
                    session = db.exec(
                        select(WS)
                        .where(WS.user_id == row.user_id)
                        .where(WS.workout_date == row.workout_date)
                    ).first()

                    if session:
                        exercises = db.exec(
                            select(WorkoutExercise)
                            .where(WorkoutExercise.session_id == session.id)
                        ).all()
                        if exercises:
                            ex_list = []
                            for ex in exercises:
                                seed = seed_map.get(ex.name.lower(), {})
                                sets_count = db.exec(
                                    select(ExerciseSet)
                                    .where(ExerciseSet.workout_exercise_id == ex.id)
                                    .where(ExerciseSet.completed == True)
                                ).all()
                                ex_list.append({
                                    "name": ex.name,
                                    "primary_muscle": seed.get("primary_muscle", ""),
                                    "secondary_muscles": seed.get("secondary_muscles", []),
                                    "is_compound": seed.get("is_compound", False),
                                    "sets_logged": len(sets_count),
                                })
                            if ex_list:
                                resolved = resolve_exercise_fatigue(
                                    ex_list,
                                    intensity=row.activity_intensity or row.stimulus or "moderate",
                                    duration_minutes=max(1, row.duration_seconds // 60) if row.duration_seconds else 60,
                                )
                                row.resolved_muscle_fatigue = resolved
                                db.add(row)
                                backfilled += 1
                                continue

                    # Fallback: use focus label
                    resolved = resolve_focus_fatigue(
                        row.focus_label,
                        intensity=row.activity_intensity or "moderate",
                        duration_minutes=max(1, row.duration_seconds // 60) if row.duration_seconds else 60,
                    )
                    row.resolved_muscle_fatigue = resolved
                    db.add(row)
                    backfilled += 1

                if backfilled:
                    db.commit()
                logger.info("fatigue_backfill_done", extra={"backfilled": backfilled, "total": len(rows)})
        except Exception:
            logger.exception("fatigue_backfill_failed")
    threading.Thread(target=_worker, daemon=True, name="backfill-muscle-fatigue").start()


def _startup_backfill_gut_health():
    """Classify every distinct food name + compute daily gut/longevity metrics
    for historical logs. Idempotent; skips rows already at the current version.
    AI fallback stays off by default to avoid surprise API costs — flip
    GUT_BACKFILL_ALLOW_AI=1 to enable during a deliberate pass."""
    import os, threading
    if os.getenv("GUT_BACKFILL_ENABLED", "1") != "1":
        logger.info("gut_backfill_disabled", extra={"reason": "GUT_BACKFILL_ENABLED=0"})
        return
    allow_ai = os.getenv("GUT_BACKFILL_ALLOW_AI", "0") == "1"

    def _worker():
        try:
            from app.services.nutrition.gut_backfill import run_full_backfill
            stats = run_full_backfill(allow_ai=allow_ai)
            logger.info("gut_backfill_startup_done", extra=stats)
        except Exception:
            logger.exception("gut_backfill_startup_failed")

    threading.Thread(target=_worker, daemon=True, name="backfill-gut-health").start()


@app.on_event("startup")
def on_startup():
    logger.info("app_startup", extra={"version": app.version})
    create_db_and_tables()
    _cleanup_orphaned_plan_jobs()
    _startup_enrich_food_micros()
    _startup_enrich_exercise_images()
    _startup_backfill_muscle_fatigue()
    _startup_backfill_gut_health()
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
app.include_router(workouts.router)
app.include_router(meals.router)
app.include_router(meta.router)
app.include_router(ai.router)
app.include_router(coach.router)


@app.get("/health")
def health():
    """Liveness probe — returns 200 as long as the process is up. Used by
    App Runner / ECS to decide whether to restart the container."""
    return {"status": "ok", "version": app.version}


@app.get("/ready")
def ready():
    """Readiness probe — returns 200 only when the service can reach its
    dependencies (DB). App Runner / load balancers should wait for this
    to succeed before routing user traffic."""
    try:
        with Session(engine) as s:
            s.exec(text("SELECT 1"))
    except Exception:
        logger.exception("ready_probe_failed")
        from fastapi import HTTPException
        raise HTTPException(status_code=503, detail="database unavailable")
    return {"ready": True}
