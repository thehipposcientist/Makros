# Thallo — CLAUDE.md

## Project Overview
Thallo is a premium fitness and nutrition app built with React Native (Expo) and a FastAPI backend. Users complete onboarding (goal, schedule, equipment, foods), then get a deterministic workout plan + AI-generated nutrition plan. The app tracks workouts, meals, weight, fatigue, and recovery — adapting recommendations based on real training data.

## Tech Stack
- **Frontend**: React Native 0.81.5 / Expo SDK ~54 / expo-router v6 / TypeScript
- **Backend**: FastAPI + SQLModel + PostgreSQL 16 (Docker)
- **AI**: OpenAI gpt-4o-mini for nutrition plans, coach chat, food scanning
- **Workout planner**: Fully deterministic — no AI in the exercise selection pipeline
- **External data**: USDA FoodData Central (food nutrition), wger.de (exercise images/search)

## Architecture

### Workout System (Deterministic)
```
User Profile -> GoalProfile -> WeeklyRecipe -> DayArchetype -> Slots -> ExerciseSelection -> Prescription
```
- `goal_profiles.py` — maps goals to training mix, allowed archetypes, planner mode
- `weekly_recipe.py` — generates the weekly archetype sequence with intensity spacing
- `day_templates.py` — picks splits, maps archetypes to exercise slots
- `planner.py` — core orchestrator: slot filling, scoring, exercise selection
- `prescriptions.py` — sets/reps/rest per archetype and slot role
- `activity_impact.py` — 12-muscle-group fatigue model with decay and derived readiness

### Nutrition System (AI + Deterministic)
- AI generates meal templates via structured JSON prompts
- Deterministic macro solver calculates targets from TDEE
- USDA FoodData Central for food search (AI fallback)
- Meal routines, preserved meals, per-day editing

### AI Coach (Unified)
- Single chat interface for workout + nutrition questions
- Exercise swaps, meal modifications, injury handling, goal changes
- Day-level focus changes are deterministic (not AI) via Switch Day button

## File Structure
```
app/
  _layout.tsx          # Root Stack navigator
  index.tsx            # Auth -> Onboarding -> HomeScreen routing
src/
  screens/             # 7 screens (Auth, Onboarding, Home, ActiveWorkout, EditProfile, Progress, Supplements)
  components/          # 19 components (WorkoutCard, NutritionCard, LogActivityModal, MealEditModal, etc.)
  utils/               # weightHistory, exerciseImages, mealTracker, workoutHistory
  constants/           # goalConfig, muscleLibrary, muscleImages, theme (27 themes)
  services/api.ts      # All backend API calls
  hooks/useMetaData.ts # Cached metadata (foods, equipment, goals, paces)
backend/
  app/
    main.py            # FastAPI with startup hooks (exercise images, food enrichment, fatigue backfill)
    models.py          # SQLModel tables
    routers/           # auth, workouts, meals, meta, profile, ai/ (plans, chat, scanning, progression)
    services/workout/  # 25 files: planner, fatigue, recipes, prescriptions, goals
    services/nutrition/ # meal assembly, calorie calc, plan review
    services/usda_fdc.py # USDA FoodData Central client
```

## Dev Commands
```bash
docker compose up -d                          # Start backend + DB
docker compose build backend && docker compose up -d backend  # Rebuild
npx expo start --clear                        # Start frontend
docker compose logs -f backend                # Backend logs
docker exec thallo-pg psql -U thallo -d thallo  # DB shell
```

## Environment Variables (backend/.env)
```
SECRET_KEY=<change for production>
OPENAI_API_KEY=<your key>
USDA_FDC_API_KEY=<get free key from https://fdc.nal.usda.gov/api-key-signup>
MODEL_CHAT=gpt-4o-mini
MODEL_PLAN_GENERATION=gpt-4o-mini
MODEL_MEAL_PARSING=gpt-4o-mini
PLAN_REVIEW_ENABLED=1
NUTRITION_REVIEW_ENABLED=1
```

## Key Design Decisions
- Workout planner is deterministic — no AI in exercise selection, split logic, or weekly recipe
- AI is gated — used only for nutrition plans, coach chat, food scanning
- Fatigue is muscle-group based — 12 dimensions, not pattern-based
- Day focus changes are UI buttons, not AI
- Food data: USDA first, AI fallback. Exercise search: wger first, AI fallback

## Supported Goals
fat_loss, muscle_gain, body_recomp, strength, endurance, athletic_performance, hyrox, toning, maintain, general_health

## Supported Splits
PPL, Upper/Lower, Full Body, PPL+UL hybrid, Bro split (auto-selected based on goal + days)
