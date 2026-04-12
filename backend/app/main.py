from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from app.database import create_db_and_tables, engine
from app.routers import auth, profile, workouts, meals, meta, ai, coach

app = FastAPI(title="Makros API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this before deploying
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cleanup_orphaned_plan_jobs() -> None:
    """Mark any `queued` or `running` plan jobs as `failed` on startup.

    FastAPI BackgroundTasks run in-memory, so a container restart or crash
    leaves those jobs in limbo — the row says `running` but nothing is
    actually working on it. Without this hook the client polls forever.
    We sweep them once at boot and let the client re-enqueue if it wants to
    retry. Error message is a known sentinel so the client can detect it
    and suppress the scary alert.
    """
    from app.models import PlanJob  # local import to avoid import cycles
    try:
        with Session(engine) as db:
            orphans = db.exec(
                select(PlanJob).where(PlanJob.status.in_(["queued", "running"]))
            ).all()
            if not orphans:
                return
            now = datetime.now(timezone.utc)
            for job in orphans:
                job.status = "failed"
                job.error = "orphaned_on_restart"
                job.updated_at = now
                job.completed_at = now
                db.add(job)
            db.commit()
            print(f"[startup] cleaned up {len(orphans)} orphaned plan job(s)")
    except Exception as e:
        # Never block startup on cleanup. Worst case the client times out on
        # its own.
        print(f"[startup] orphan cleanup failed: {e}")


@app.on_event("startup")
def on_startup():
    create_db_and_tables()
    _cleanup_orphaned_plan_jobs()


app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(workouts.router)
app.include_router(meals.router)
app.include_router(meta.router)
app.include_router(ai.router)
app.include_router(coach.router)


@app.get("/health")
def health():
    return {"status": "ok"}
