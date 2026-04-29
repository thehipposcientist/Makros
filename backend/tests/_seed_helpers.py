from __future__ import annotations

from sqlmodel import SQLModel, create_engine
from sqlalchemy.pool import StaticPool


def make_seed_test_engine():
    """Create an in-memory DB with the full app model registry loaded."""
    from app import models  # noqa: F401

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def point_app_database_at(engine) -> None:
    """Route helpers that import app.database.engine to this test engine."""
    from app import database as app_db

    app_db.engine = engine
