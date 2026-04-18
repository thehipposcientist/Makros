# Thallo — Automated Test Plan

Last updated: 2026-04-18

## Current State

- **181 unit tests** across 10 files in `backend/tests/`
- All tests are pure unit tests (no DB, no HTTP, no Docker required at test time)
- Custom test runner (`run_all.py`) — not pytest-compatible
- 3 test modules (60 tests) not registered in `run_all.py` — silently skipped
- **Zero frontend tests**
- **Zero integration tests**
- **No CI/CD pipeline**

## Priority 1: Fix What Exists

### 1a. Register all test modules in `run_all.py`
Add `test_workout_goals`, `test_focus_differentiation`, `test_workout_archetypes` to `_TEST_MODULES`. This immediately adds 60 tests to `make test`.

### 1b. Add nutrition_score tests
The nutrition scoring system has no tests despite being user-facing. Test file: `test_nutrition_score.py`.

### 1c. Add calorie_calculator safety tests
Verify the safety floor is enforced. Regression test to prevent re-disabling.

---

## Priority 2: Seed Data Fixtures

Create `backend/tests/fixtures.py` with deterministic seed data for all test scenarios.

### User Profiles

```python
BEGINNER_MALE = {
    "sex": "male",
    "age": 25,
    "height_cm": 178,
    "weight_kg": 80,
    "activity_level": "moderately_active",
    "goal": "muscle_gain",
    "experience": "beginner",
    "days_per_week": 4,
    "session_minutes": 60,
    "equipment": ["barbell", "dumbbells", "cable_machine", "pull_up_bar", "bench"],
    "dietary_preference": "none",
    "allergies": [],
    "meals_per_day": 3,
}

INTERMEDIATE_FEMALE = {
    "sex": "female",
    "age": 30,
    "height_cm": 165,
    "weight_kg": 60,
    "activity_level": "very_active",
    "goal": "fat_loss",
    "experience": "intermediate",
    "days_per_week": 5,
    "session_minutes": 50,
    "equipment": ["barbell", "dumbbells", "cable_machine", "pull_up_bar", "bench", "leg_press"],
    "dietary_preference": "none",
    "allergies": ["peanuts"],
    "meals_per_day": 4,
}

ADVANCED_STRENGTH = {
    "sex": "male",
    "age": 35,
    "height_cm": 185,
    "weight_kg": 100,
    "activity_level": "extra_active",
    "goal": "strength",
    "experience": "advanced",
    "days_per_week": 6,
    "session_minutes": 90,
    "equipment": ["barbell", "dumbbells", "cable_machine", "pull_up_bar", "bench", "squat_rack", "leg_press"],
    "dietary_preference": "none",
    "allergies": [],
    "meals_per_day": 4,
}

SMALL_FEMALE_FAT_LOSS = {
    "sex": "female",
    "age": 45,
    "height_cm": 157,
    "weight_kg": 54,
    "activity_level": "sedentary",
    "goal": "fat_loss",
    "experience": "beginner",
    "days_per_week": 3,
    "session_minutes": 30,
    "equipment": ["dumbbells", "bodyweight"],
    "dietary_preference": "vegetarian",
    "allergies": ["gluten"],
    "meals_per_day": 3,
}

HYROX_ATHLETE = {
    "sex": "male",
    "age": 28,
    "height_cm": 180,
    "weight_kg": 78,
    "activity_level": "extra_active",
    "goal": "hyrox",
    "experience": "intermediate",
    "days_per_week": 5,
    "session_minutes": 75,
    "equipment": ["barbell", "dumbbells", "cable_machine", "pull_up_bar", "bench", "rower", "ski_erg", "sled"],
    "dietary_preference": "none",
    "allergies": [],
    "meals_per_day": 4,
}

ENDURANCE_RUNNER = {
    "sex": "female",
    "age": 32,
    "height_cm": 170,
    "weight_kg": 58,
    "activity_level": "extra_active",
    "goal": "endurance",
    "experience": "intermediate",
    "days_per_week": 5,
    "session_minutes": 60,
    "equipment": ["bodyweight", "dumbbells", "resistance_bands"],
    "dietary_preference": "none",
    "allergies": ["dairy"],
    "meals_per_day": 4,
}

GENERAL_HEALTH_SENIOR = {
    "sex": "male",
    "age": 62,
    "height_cm": 175,
    "weight_kg": 85,
    "activity_level": "lightly_active",
    "goal": "general_health",
    "experience": "beginner",
    "days_per_week": 3,
    "session_minutes": 45,
    "equipment": ["dumbbells", "cable_machine", "bodyweight"],
    "dietary_preference": "none",
    "allergies": [],
    "meals_per_day": 3,
}
```

### Workout History (for fatigue/progression tests)

```python
# Simulates a week of PPL training for the BEGINNER_MALE profile
WEEK_PPL_HISTORY = [
    {
        "date": "2026-04-14",  # Monday — Push
        "focus": "push",
        "exercises": [
            {"name": "Bench Press", "muscles": ["chest", "shoulders", "triceps"], "sets": [
                {"reps": 10, "weight_lbs": 135}, {"reps": 9, "weight_lbs": 135},
                {"reps": 8, "weight_lbs": 135}, {"reps": 7, "weight_lbs": 135},
            ]},
            {"name": "Overhead Press", "muscles": ["shoulders", "triceps"], "sets": [
                {"reps": 10, "weight_lbs": 85}, {"reps": 9, "weight_lbs": 85},
                {"reps": 8, "weight_lbs": 85},
            ]},
            {"name": "Tricep Pushdown", "muscles": ["triceps"], "sets": [
                {"reps": 12, "weight_lbs": 50}, {"reps": 12, "weight_lbs": 50},
                {"reps": 10, "weight_lbs": 50},
            ]},
        ],
        "duration_minutes": 55,
    },
    {
        "date": "2026-04-15",  # Tuesday — Pull
        "focus": "pull",
        "exercises": [
            {"name": "Barbell Row", "muscles": ["back", "biceps"], "sets": [
                {"reps": 10, "weight_lbs": 135}, {"reps": 9, "weight_lbs": 135},
                {"reps": 8, "weight_lbs": 135}, {"reps": 7, "weight_lbs": 135},
            ]},
            {"name": "Lat Pulldown", "muscles": ["back", "biceps"], "sets": [
                {"reps": 12, "weight_lbs": 100}, {"reps": 11, "weight_lbs": 100},
                {"reps": 10, "weight_lbs": 100},
            ]},
            {"name": "Barbell Curl", "muscles": ["biceps"], "sets": [
                {"reps": 12, "weight_lbs": 50}, {"reps": 10, "weight_lbs": 50},
                {"reps": 10, "weight_lbs": 50},
            ]},
        ],
        "duration_minutes": 50,
    },
    {
        "date": "2026-04-16",  # Wednesday — Legs
        "focus": "legs",
        "exercises": [
            {"name": "Barbell Squat", "muscles": ["quads", "glutes", "hamstrings", "core"], "sets": [
                {"reps": 8, "weight_lbs": 185}, {"reps": 7, "weight_lbs": 185},
                {"reps": 6, "weight_lbs": 185}, {"reps": 6, "weight_lbs": 185},
            ]},
            {"name": "Romanian Deadlift", "muscles": ["hamstrings", "glutes", "back"], "sets": [
                {"reps": 10, "weight_lbs": 135}, {"reps": 9, "weight_lbs": 135},
                {"reps": 8, "weight_lbs": 135},
            ]},
            {"name": "Leg Press", "muscles": ["quads", "glutes"], "sets": [
                {"reps": 12, "weight_lbs": 270}, {"reps": 11, "weight_lbs": 270},
                {"reps": 10, "weight_lbs": 270},
            ]},
        ],
        "duration_minutes": 60,
    },
]

# High-fatigue scenario: back-to-back heavy sessions
HIGH_FATIGUE_HISTORY = [
    {
        "date": "2026-04-16",  # Wednesday — Heavy Squat
        "focus": "legs",
        "exercises": [
            {"name": "Barbell Squat", "muscles": ["quads", "glutes", "hamstrings", "core"], "sets": [
                {"reps": 3, "weight_lbs": 315}, {"reps": 3, "weight_lbs": 315},
                {"reps": 2, "weight_lbs": 315}, {"reps": 2, "weight_lbs": 315},
                {"reps": 1, "weight_lbs": 335},
            ]},
            {"name": "Deadlift", "muscles": ["hamstrings", "glutes", "back", "core"], "sets": [
                {"reps": 3, "weight_lbs": 365}, {"reps": 2, "weight_lbs": 365},
                {"reps": 1, "weight_lbs": 385},
            ]},
        ],
        "duration_minutes": 75,
        "rpe_avg": 9.5,
    },
    {
        "date": "2026-04-17",  # Thursday — Heavy Upper
        "focus": "upper",
        "exercises": [
            {"name": "Bench Press", "muscles": ["chest", "shoulders", "triceps"], "sets": [
                {"reps": 3, "weight_lbs": 225}, {"reps": 2, "weight_lbs": 225},
                {"reps": 2, "weight_lbs": 225}, {"reps": 1, "weight_lbs": 245},
            ]},
            {"name": "Weighted Pull-ups", "muscles": ["back", "biceps"], "sets": [
                {"reps": 5, "weight_lbs": 45}, {"reps": 4, "weight_lbs": 45},
                {"reps": 3, "weight_lbs": 45},
            ]},
        ],
        "duration_minutes": 70,
        "rpe_avg": 9.0,
    },
]
```

### Meal Plan Data (for nutrition scoring tests)

```python
BALANCED_MEAL_PLAN = {
    "meals": [
        {
            "meal": "Breakfast",
            "foods": ["Oatmeal", "Banana", "Protein shake"],
            "items": [
                {"name": "Oatmeal", "quantity": 1, "unit": "cup", "calories": 307, "protein": 11, "carbs": 55, "fat": 5, "micronutrients": {"iron_mg": 3.4, "magnesium_mg": 56}},
                {"name": "Banana", "quantity": 1, "unit": "whole", "calories": 105, "protein": 1, "carbs": 27, "fat": 0, "micronutrients": {"potassium_mg": 422, "vitamin_c_mg": 10}},
                {"name": "Whey Protein", "quantity": 1, "unit": "scoop", "calories": 120, "protein": 24, "carbs": 3, "fat": 1},
            ],
            "calories": 532, "protein": 36, "carbs": 85, "fat": 6, "fiber": 8,
        },
        {
            "meal": "Lunch",
            "foods": ["Chicken breast", "Brown rice", "Broccoli"],
            "items": [
                {"name": "Chicken Breast", "quantity": 6, "unit": "oz", "calories": 280, "protein": 52, "carbs": 0, "fat": 6, "micronutrients": {"iron_mg": 1.2, "zinc_mg": 2.5, "vitamin_b12_mcg": 0.6}},
                {"name": "Brown Rice", "quantity": 1, "unit": "cup", "calories": 216, "protein": 5, "carbs": 45, "fat": 2, "micronutrients": {"magnesium_mg": 84, "iron_mg": 0.8}},
                {"name": "Broccoli", "quantity": 1.5, "unit": "cup", "calories": 50, "protein": 4, "carbs": 10, "fat": 0, "micronutrients": {"vitamin_c_mg": 101, "calcium_mg": 62, "iron_mg": 1.0, "potassium_mg": 460}},
            ],
            "calories": 546, "protein": 61, "carbs": 55, "fat": 8, "fiber": 7,
        },
        {
            "meal": "Dinner",
            "foods": ["Salmon", "Sweet potato", "Spinach"],
            "items": [
                {"name": "Salmon", "quantity": 6, "unit": "oz", "calories": 350, "protein": 38, "carbs": 0, "fat": 20, "micronutrients": {"vitamin_d_mcg": 14, "vitamin_b12_mcg": 4.8, "calcium_mg": 18, "potassium_mg": 534}},
                {"name": "Sweet Potato", "quantity": 1, "unit": "whole", "calories": 103, "protein": 2, "carbs": 24, "fat": 0, "micronutrients": {"vitamin_a_mcg": 961, "potassium_mg": 438, "vitamin_c_mg": 20}},
                {"name": "Spinach", "quantity": 2, "unit": "cup", "calories": 14, "protein": 2, "carbs": 2, "fat": 0, "micronutrients": {"iron_mg": 1.6, "calcium_mg": 60, "magnesium_mg": 24, "potassium_mg": 168, "vitamin_a_mcg": 141}},
            ],
            "calories": 467, "protein": 42, "carbs": 26, "fat": 20, "fiber": 6,
        },
    ],
    "targets": {"calories": 2200, "protein": 165, "carbs": 250, "fat": 65},
}

PROCESSED_MEAL_PLAN = {
    "meals": [
        {
            "meal": "Breakfast",
            "foods": ["Protein bar", "Energy drink"],
            "items": [
                {"name": "Protein Bar", "quantity": 1, "unit": "bar", "calories": 250, "protein": 20, "carbs": 30, "fat": 8},
                {"name": "Energy Drink", "quantity": 1, "unit": "can", "calories": 110, "protein": 0, "carbs": 28, "fat": 0},
            ],
            "calories": 360, "protein": 20, "carbs": 58, "fat": 8, "fiber": 1,
        },
        {
            "meal": "Lunch",
            "foods": ["Frozen dinner", "Chips"],
            "items": [
                {"name": "Frozen Dinner Pasta", "quantity": 1, "unit": "serving", "calories": 450, "protein": 15, "carbs": 55, "fat": 18},
                {"name": "Chips", "quantity": 1, "unit": "bag", "calories": 160, "protein": 2, "carbs": 15, "fat": 10},
            ],
            "calories": 610, "protein": 17, "carbs": 70, "fat": 28, "fiber": 2,
        },
        {
            "meal": "Dinner",
            "foods": ["Pizza"],
            "items": [
                {"name": "Pizza", "quantity": 3, "unit": "slice", "calories": 810, "protein": 30, "carbs": 90, "fat": 36},
            ],
            "calories": 810, "protein": 30, "carbs": 90, "fat": 36, "fiber": 3,
        },
    ],
    "targets": {"calories": 2200, "protein": 165, "carbs": 250, "fat": 65},
}

EMPTY_PLAN = {
    "meals": [],
    "targets": {"calories": 2000, "protein": 150, "carbs": 200, "fat": 60},
}
```

---

## Priority 3: New Test Suites

### Test: Nutrition Score (`test_nutrition_score.py`)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | Balanced whole-food plan | `BALANCED_MEAL_PLAN` + muscle_gain | Score >= 65, adherence >= 70, quality >= 60 |
| 2 | Processed food plan | `PROCESSED_MEAL_PLAN` + muscle_gain | Score < 45, quality < 30, "High processed-food day" in tags |
| 3 | Empty plan | `EMPTY_PLAN` | Score = 0, improvements includes "Add meals" |
| 4 | Perfect macro alignment | Plan matching targets exactly | Adherence >= 90 |
| 5 | Massive calorie overshoot | 2x target calories | calorie_alignment < 0.3 |
| 6 | Protein target hit | Plan at 100% protein target | "Protein target hit" in wins |
| 7 | Protein far below target | Plan at 50% protein | "Protein below target" in improvements |
| 8 | High fruit/veg plan | 5+ items matching fruit/veg keywords | "Good produce intake" in wins |
| 9 | Zero fruit/veg | No fruit/veg items | "More fruits and vegetables" in improvements |
| 10 | Micronutrients populated | Items with full micronutrient data | micro_confidence != "none", likely_gaps populated appropriately |
| 11 | No micronutrient data | Items without .micronutrients | micro = 50 (neutral), confidence = "low" |
| 12 | Goal weight adjustment | Same plan, fat_loss vs muscle_gain | Different total scores (adherence weighted more for muscle_gain) |
| 13 | Single removed meal | Plan with removedMealIds | Removed meal excluded from totals |
| 14 | Fiber target met | Plan with fiber >= 28g | "Fiber target hit" in wins |

### Test: Calorie Calculator Safety (`test_calorie_safety.py`)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | Small female aggressive cut | SMALL_FEMALE_FAT_LOSS profile | calories >= 1200 |
| 2 | Male aggressive cut | Standard male, fat_loss, aggressive | calories >= 1500 |
| 3 | Sedentary + extreme deficit | Lowest TDEE possible | Never below MIN_SAFE_CALORIES |
| 4 | Child-age rejection | age=15 | Appropriate handling (no sub-1500 for minors) |

### Test: Fatigue System (`test_fatigue_system.py`)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | Fresh user readiness | No workout history | All muscles at 0.0 fatigue, readiness = 100% |
| 2 | Post-push readiness | WEEK_PPL_HISTORY[0] done yesterday | chest/shoulders/triceps fatigued, back/legs fresh |
| 3 | Post-full-PPL readiness | All 3 days done M-W, checking Friday | Significant decay, most muscles recoverable |
| 4 | Heavy back-to-back | HIGH_FATIGUE_HISTORY | Force-recovery triggered for legs, systemic high |
| 5 | Systemic fatigue after heavy deadlift | Heavy DL session | systemic >= 0.5 |
| 6 | Decay after 3 days | Session 3 days ago | All muscle fatigue * 0.10 (near zero) |
| 7 | Derived focus readiness — push | Chest 0.5, shoulders 0.3, triceps 0.2 | push readiness reflects weighted average |
| 8 | Blocked focuses | quads at 0.9 | legs focus blocked |

### Test: Weekly Recipe (`test_weekly_recipe.py`)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | PPL at 3 days | muscle_gain, 3 days | Exactly [Push, Pull, Legs] |
| 2 | PPL at 6 days | muscle_gain, 6 days | Full PPL x2 |
| 3 | Upper/Lower at 4 | body_recomp, 4 days | [Upper, Lower, Upper, Lower] |
| 4 | No back-to-back heavy | Any 5+ day plan | No 2 consecutive high-intensity days |
| 5 | HYROX includes running | hyrox, 4+ days | At least 1 COND_TEMPO in recipe |
| 6 | Fat loss has conditioning | fat_loss, 4 days | At least 1 conditioning archetype |
| 7 | Rest day placement | Any 5-day plan | At least 1 rest day between heavy blocks |
| 8 | Endurance strength placement | endurance, 5 days | Exactly 1 lifting day |

### Test: Prescription Consistency (`test_prescriptions.py`)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | Hypertrophy rep range | LIFT_UPPER, muscle_gain | Primary: 6-12 reps, rest 90-120s |
| 2 | Strength rep range | LIFT_UPPER_HEAVY, strength | Primary: 3-5 reps, rest 180+s |
| 3 | Endurance maintenance | strength_maintenance slot | 15-20 reps, rest 30-60s (currently broken: returns 6-10) |
| 4 | RIR consistency | Same user, same slot, different paths | RIR values match between planner and prescriptions |
| 5 | Short interval rest ratio | COND_INTERVALS_SHORT | Rest >= 90s for 30-45s work intervals |

### Test: Slot Coverage (`test_slot_coverage.py`)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | Push has triceps compound | _push_slots | At least 1 triceps slot with movement_pattern=compound |
| 2 | Lower has glute isolation | _lower_hypertrophy_slots | At least 1 glute isolation slot |
| 3 | Upper heavy has vertical pull | _upper_heavy_slots | At least 1 vertical pull slot |
| 4 | All templates have core | Every template | Core slot present (except arms-only bro day) |

### Test: API Router Smoke Tests (`test_routers.py`)

| # | Test Case | Expected |
|---|-----------|----------|
| 1 | POST /auth/signup with valid data | 201 + token |
| 2 | POST /auth/signup with short password | 422 |
| 3 | POST /auth/login with wrong password | 401 |
| 4 | GET /workouts/generate-day without auth | 401 |
| 5 | GET /profile/me with valid token | 200 + profile |
| 6 | GET /ai/smoke-test without auth | 401 (after fix) |
| 7 | PUT /profile/state with 10MB body | 413 or 422 (after fix) |
| 8 | GET /profile/nutrition-score with auth | 200 + valid shape |

---

## Priority 4: Frontend Tests

### Setup
```bash
npx expo install jest-expo @testing-library/react-native @testing-library/jest-native
```

### Key Frontend Tests

| # | Component/Screen | Test Case |
|---|-----------------|-----------|
| 1 | `nutritionScore.ts` | computeNutritionScore with BALANCED_MEAL_PLAN returns expected range |
| 2 | `nutritionScore.ts` | computeNutritionScore with empty plan returns score=0 |
| 3 | `nutritionScore.ts` | Score updates when meal is removed (removedMealIds) |
| 4 | `mealTracker.ts` | computeDietConsistency with 3 meals/day |
| 5 | `weightHistory.ts` | Save and load weight entries round-trips correctly |
| 6 | `exerciseGuide.ts` | humanizeToken converts slugs to readable names |
| 7 | `WorkoutCard` | Renders exercise list with correct set/rep display |
| 8 | `MealEditModal` | Adding a food updates macros correctly |

---

## Running Tests

```bash
# Backend unit tests (current)
make test
# or: docker exec makros-backend python -m tests.run_all

# Backend with all modules registered (after fix)
make test  # now includes goals, focus, archetypes

# Future: pytest migration
docker exec makros-backend python -m pytest tests/ -v --tb=short

# Future: frontend
npx jest --config jest.config.js
```

---

## CI/CD Pipeline (Future)

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: thallo_test
          POSTGRES_USER: thallo
          POSTGRES_PASSWORD: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r backend/requirements.txt
      - run: python -m tests.run_all
        working-directory: backend
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx jest --ci
```
