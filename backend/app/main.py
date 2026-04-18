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


def _startup_enrich_food_micros():
    """Ensure every FoodNutrition row has the Layer 2 micronutrient
    panel present in `extra_nutrients`. Runs on server startup as a
    background thread so it never blocks boot.

    Idempotent + incremental — only enriches rows missing Layer 2
    keys. Gated by `STARTUP_ENRICH_FOODS_ENABLED=1` env var (on by
    default; set to 0 to disable during testing)."""
    import os
    if os.getenv("STARTUP_ENRICH_FOODS_ENABLED", "1") != "1":
        print("[startup] food micro enrichment DISABLED (set STARTUP_ENRICH_FOODS_ENABLED=1 to enable)")
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
                    print(f"[startup] food enrichment: {len(rows)} rows already complete, nothing to do")
                    return
                print(f"[startup] food enrichment: {len(thin)}/{len(rows)} rows missing Layer 2 data — starting background enrichment")

            api_key = get_openai_api_key()
            if not api_key:
                print("[startup] food enrichment: no OpenAI key, skipping")
                return
            client = OpenAI(api_key=api_key)

            # Import the enrichment helper from the script so we don't
            # duplicate the prompt + sanity-check logic.
            import sys
            sys.path.insert(0, "/app")
            try:
                from enrich_food_micros import _ai_enrich_batch, BATCH_SIZE
            except Exception as e:
                print(f"[startup] food enrichment: failed to import helper: {e}")
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
                print(f"[startup] food enrichment: DONE — enriched {enriched}/{len(pairs)} foods")
        except Exception as e:
            print(f"[startup] food enrichment failed (non-fatal): {e}")

    threading.Thread(target=_worker, daemon=True, name="enrich-food-micros").start()
    print("[startup] food enrichment kicked off in background thread")


def _startup_enrich_exercise_images():
    """Background: clean generic images then re-enrich from wger.de."""
    import threading
    def _worker():
        try:
            from app.seed_exercise_images import seed_exercise_images, clear_bad_images
            clear_bad_images(engine)
            seed_exercise_images(engine)
        except Exception as e:
            print(f"[startup] exercise image enrichment failed (non-fatal): {e}")
    threading.Thread(target=_worker, daemon=True, name="enrich-exercise-images").start()


@app.on_event("startup")
def on_startup():
    create_db_and_tables()
    _cleanup_orphaned_plan_jobs()
    _startup_enrich_food_micros()
    _startup_enrich_exercise_images()


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
