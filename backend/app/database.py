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
    # Import all models to register them with SQLModel.metadata
    from app.models import Exercise, Food, Equipment, GoalOption, PaceOption, User, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState
    
    SQLModel.metadata.create_all(engine)
    from app.seed import seed_exercises, seed_foods, seed_equipment, seed_goals
    with Session(engine) as session:
        seed_exercises(session)
        seed_foods(session)
        seed_equipment(session)
        seed_goals(session)


def get_session():
    with Session(engine) as session:
        yield session
