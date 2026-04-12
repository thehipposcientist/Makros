from sqlmodel import SQLModel, create_engine, Session
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./workoutpal.db")

# SQLite needs check_same_thread=False; PostgreSQL doesn't use it
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    echo=False,
    pool_pre_ping=True,  # reconnect stale connections (useful for PostgreSQL)
)


def create_db_and_tables():
    # Import all models to register them with SQLModel.metadata
    from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood, Equipment, ExerciseEquipment, GoalOption, PaceOption, User, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState, DailyRollup, UserRollup, UserFlag, AIDecision
    
    SQLModel.metadata.create_all(engine)
    from app.seed import seed_equipment, seed_exercises, seed_foods, seed_goals
    with Session(engine) as session:
        seed_equipment(session)   # must run before exercises (FK dependency)
        seed_exercises(session)
        seed_foods(session)
        seed_goals(session)


def get_session():
    with Session(engine) as session:
        yield session
