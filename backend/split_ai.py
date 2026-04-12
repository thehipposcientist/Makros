"""Split ai.py into a modular package."""
import os

# Read the full ai.py
with open('backend/app/routers/ai.py', 'r') as f:
    content = f.read()

lines = content.split('\n')

def extract(start, end):
    """Extract lines [start, end) (0-indexed)"""
    return '\n'.join(lines[start:end])

pkg = 'backend/app/routers/ai_pkg'
os.makedirs(pkg, exist_ok=True)

# ── __init__.py ──
with open(f'{pkg}/__init__.py', 'w') as f:
    f.write('from .router import router  # noqa: F401\n')

# ── router.py ──
with open(f'{pkg}/router.py', 'w') as f:
    f.write('from fastapi import APIRouter\n\n')
    f.write('router = APIRouter(prefix="/ai", tags=["ai"])\n')
    f.write('print("[AI ROUTER IMPORTED] CODE_VERSION=V7_MODULAR")\n\n')
    f.write('# Import endpoint modules so their @router decorators register routes\n')
    f.write('from . import plans, chat, scanning, progression  # noqa: F401, E402\n')

# ── models.py ──
with open(f'{pkg}/models.py', 'w') as f:
    f.write('from __future__ import annotations\nfrom pydantic import BaseModel\n\n\n')
    # PhysicalStatsIn through BodyScanRequest (lines 65-259)
    f.write(extract(65, 260))
    f.write('\n\n')
    # ParseWorkoutsRequest (lines 2033-2037)
    f.write(extract(2033, 2038))
    f.write('\n\n')
    # WorkoutSummaryRequest (lines 2822-2828)
    f.write(extract(2822, 2829))
    f.write('\n')

# ── utils.py ──
with open(f'{pkg}/utils.py', 'w') as f:
    f.write('from __future__ import annotations\n\n')
    f.write('import json\nimport math\nimport os\nimport re\n\n')
    f.write('import openai\nfrom openai import OpenAI\n\n')
    f.write('from app.workout_progression import (\n')
    f.write('    EffortFeedback,\n    ExerciseCategory,\n    ExercisePrescription,\n')
    f.write('    ExperienceLevel,\n    GoalType,\n    PhaseType,\n    PlannedSet,\n')
    f.write('    ProgressionPace,\n    ProgressionPriority,\n    ReadinessInput,\n')
    f.write('    RecoveryLevel,\n    SetResult,\n    SetType,\n')
    f.write('    UserTrainingProfile,\n    WorkoutContext,\n    WorkoutFocus,\n')
    f.write('    WorkoutProgressionEngine,\n)\n\n')
    f.write('from .models import PlanRequest\n\n')
    f.write('progression_engine = WorkoutProgressionEngine()\n\n\n')
    # get_openai_api_key + model selectors (lines 38-60)
    f.write(extract(38, 62))
    f.write('\n\n')
    # map_* functions (lines 266-427)
    f.write(extract(264, 428))
    f.write('\n\n')
    # compute_tdee_and_targets (lines 430-695)
    f.write(extract(430, 696))
    f.write('\n\n')
    # _log_openai_error through _extract_json (lines 1153-1315)
    f.write(extract(1152, 1316))
    f.write('\n\n')
    # JSON schemas (lines 1318-1587)
    f.write(extract(1317, 1588))
    f.write('\n')

# ── prompts.py ──
with open(f'{pkg}/prompts.py', 'w') as f:
    f.write('from __future__ import annotations\n\n')
    f.write('from .models import PlanRequest\n')
    f.write('from .utils import compute_tdee_and_targets\n\n\n')
    # _meal_schema_and_targets + _build_weekly_review_section + build_workout_prompt + build_nutrition_prompt
    f.write(extract(697, 1112))
    f.write('\n')

# ── plans.py ──
with open(f'{pkg}/plans.py', 'w') as f:
    f.write('from __future__ import annotations\n\n')
    f.write('import asyncio\nimport json\n\nimport openai\nfrom openai import OpenAI\n')
    f.write('from fastapi import HTTPException, Depends\n\n')
    f.write('from app.auth import get_current_user\nfrom app.models import User\n\n')
    f.write('from .router import router\n')
    f.write('from .models import PlanRequest, WorkoutOnlyRequest, NutritionOnlyRequest, ParseWorkoutsRequest\n')
    f.write('from .utils import (\n')
    f.write('    get_openai_api_key, model_plan_generation, model_plan_update,\n')
    f.write('    _build_chat_kwargs, _chat_create, _looks_truncated, _extract_json,\n')
    f.write('    _log_openai_error,\n')
    f.write('    SCHEMA_WORKOUT, SCHEMA_NUTRITION,\n)\n')
    f.write('from .prompts import build_workout_prompt, build_nutrition_prompt\n\n\n')
    # First _validate_plans (combined-plan validation, lines 1114-1150)
    f.write(extract(1114, 1151))
    f.write('\n\n')
    # _call_workout_ai (lines 1589-1630)
    f.write(extract(1589, 1631))
    f.write('\n\n')
    # _food_covered + _check_food_violations (lines 1632-1679)
    f.write(extract(1632, 1680))
    f.write('\n\n')
    # _call_nutrition_ai (lines 1681-1734)
    f.write(extract(1681, 1735))
    f.write('\n\n')
    # Second _validate_plans (renamed to avoid collision)
    f.write('def _validate_parallel_plans(result: dict, req: PlanRequest) -> None:\n')
    f.write('    """Raise ValueError if the assembled plan result is structurally invalid."""\n')
    f.write(extract(1740, 1762))
    f.write('\n\n')
    # generate_plans endpoint (lines 1900-1939)
    f.write(extract(1900, 1940))
    f.write('\n\n')
    # generate_workout_plan endpoint (lines 1941-1983)
    f.write(extract(1941, 1984))
    f.write('\n\n')
    # generate_nutrition_plan endpoint (lines 1985-2031)
    f.write(extract(1985, 2032))
    f.write('\n\n')
    # parse_recent_workouts endpoint (lines 2039-2101)
    f.write(extract(2039, 2102))
    f.write('\n')

# ── chat.py ──
with open(f'{pkg}/chat.py', 'w') as f:
    f.write('from __future__ import annotations\n\nimport json\n\n')
    f.write('import openai\nfrom openai import OpenAI\n')
    f.write('from fastapi import HTTPException, Depends\n\n')
    f.write('from app.auth import get_current_user\nfrom app.models import User\n\n')
    f.write('from .router import router\n')
    f.write('from .models import TrainerQuestionRequest, WorkoutCoachQuestionRequest\n')
    f.write('from .utils import (\n')
    f.write('    get_openai_api_key, model_chat, model_chat_fallback,\n')
    f.write('    _is_gpt5, _build_chat_kwargs, _chat_create, _extract_json,\n')
    f.write('    _log_openai_error,\n')
    f.write('    SCHEMA_TRAINER_QUESTION, SCHEMA_WORKOUT_QUESTION,\n)\n\n\n')
    # smoke_test endpoint (lines 1863-1898)
    f.write(extract(1863, 1899))
    f.write('\n\n')
    # ask_trainer_question endpoint (lines 2103-2446)
    f.write(extract(2103, 2447))
    f.write('\n\n')
    # ask_workout_question endpoint (lines 2447-2498)
    f.write(extract(2447, 2499))
    f.write('\n')

# ── scanning.py ──
with open(f'{pkg}/scanning.py', 'w') as f:
    f.write('from __future__ import annotations\n\nimport json\n\n')
    f.write('import openai\nfrom openai import OpenAI\n')
    f.write('from fastapi import HTTPException, Depends\n\n')
    f.write('from app.auth import get_current_user\nfrom app.models import User\n\n')
    f.write('from .router import router\n')
    f.write('from .models import (\n')
    f.write('    FoodPhotoRequest, ScanFoodsRequest, FoodNutritionSearchRequest,\n')
    f.write('    SupplementLookupRequest, SupplementPhotoRequest, FormPhotoRequest, BodyScanRequest,\n)\n')
    f.write('from .utils import (\n')
    f.write('    get_openai_api_key, model_meal_parsing, model_chat,\n')
    f.write('    _is_gpt5, _build_chat_kwargs, _chat_create, _extract_json,\n')
    f.write('    _log_openai_error,\n')
    f.write('    SCHEMA_FOOD_PHOTO, SCHEMA_SCAN_FOODS, SCHEMA_SUPPLEMENT_INFO,\n')
    f.write('    SCHEMA_SCAN_EQUIPMENT, SCHEMA_FORM_PHOTO,\n)\n\n\n')
    # All scanning endpoints (lines 2499-end)
    f.write(extract(2499, len(lines)))
    f.write('\n')

# ── progression.py ──
with open(f'{pkg}/progression.py', 'w') as f:
    f.write('from __future__ import annotations\n\nimport json\n\n')
    f.write('import openai\nfrom openai import OpenAI\n')
    f.write('from fastapi import HTTPException, Depends\n\n')
    f.write('from app.auth import get_current_user\nfrom app.models import User\n\n')
    f.write('from .router import router\n')
    f.write('from .models import WeightRecommendRequest, WorkoutSummaryRequest\n')
    f.write('from .utils import (\n')
    f.write('    get_openai_api_key, model_chat,\n')
    f.write('    _build_chat_kwargs, _chat_create, _extract_json, _log_openai_error,\n')
    f.write('    progression_engine,\n')
    f.write('    map_goal_type, map_feedback, infer_exercise_category, parse_target_reps,\n')
    f.write('    map_progression_priority, map_workout_focus, map_phase,\n')
    f.write('    map_progression_pace, map_experience_level, map_recovery_level,\n')
    f.write('    SCHEMA_WORKOUT_SUMMARY,\n)\n')
    f.write('from app.workout_progression import (\n')
    f.write('    ExerciseCategory, ExercisePrescription, PlannedSet, ReadinessInput,\n')
    f.write('    SetResult, SetType, UserTrainingProfile, WorkoutContext,\n)\n\n\n')
    # recommend_weight (lines 1765-1862)
    f.write(extract(1765, 1863))
    f.write('\n\n')
    # generate_workout_summary (lines 2829-2912)
    f.write(extract(2829, 2913))
    f.write('\n')

print("All files created successfully!")
for fname in os.listdir(pkg):
    fpath = os.path.join(pkg, fname)
    line_count = sum(1 for _ in open(fpath))
    print(f"  {fname}: {line_count} lines")
