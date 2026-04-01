from sqlmodel import SQLModel, create_engine, Session
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./workoutpal.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},  # SQLite only
    echo=False,
)


def create_db_and_tables():
    SQLModel.metadata.create_all(engine)
    from app.seed import seed_exercises
    with Session(engine) as session:
        seed_exercises(session)


def get_session():
    with Session(engine) as session:
        yield session
