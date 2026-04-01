from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import create_db_and_tables
from app.routers import auth, profile, workouts, meals, meta, ai

app = FastAPI(title="Makros API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this before deploying
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_db_and_tables()


app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(workouts.router)
app.include_router(meals.router)
app.include_router(meta.router)
app.include_router(ai.router)


@app.get("/health")
def health():
    return {"status": "ok"}
