# Thallo — CLAUDE.md

## Project Overview
Thallo is a premium fitness and nutrition app built with React Native (Expo) and a FastAPI backend. Users complete onboarding (goal, schedule, equipment, foods), then get a deterministic workout plan + AI-generated nutrition plan. The app tracks workouts, meals, weight, fatigue, and recovery — adapting recommendations based on real training data.

## Tech Stack
- **Frontend**: React Native 0.81.5 / Expo SDK ~54 / expo-router v6 / TypeScript
- **Backend**: FastAPI + SQLModel + PostgreSQL 16 (Docker)
- **AI**: OpenAI gpt-4o-mini for nutrition plans, coach chat, food scanning, in-workout set review
- **Workout planner**: Fully deterministic — no AI in exercise selection pipeline
- **External data**: USDA FoodData Central (food nutrition), wger.de (exercise images/search)

## Architecture

### Workout System (Deterministic)
```
User Profile -> GoalProfile -> WeeklyRecipe -> DayArchetype -> Slots -> ExerciseSelection -> Prescription
```
- `goal_profiles.py` — maps goals to training mix (strength/hypertrophy/power/conditioning/mobility/recovery), allowed archetypes, planner mode
- `weekly_recipe.py` — generates weekly archetype sequence with intensity spacing; separate recovery allocation from conditioning
- `day_templates.py` — picks splits, maps archetypes to exercise slots
- `slots.py` — slot definitions with density trimming
- `planner.py` — core orchestrator: slot filling, scoring, exercise selection, injury pattern blocking, dislike filtering
- `prescriptions.py` — sets/reps/rest per archetype and slot role; dispatches lifting/cardio/mobility/recovery/hybrid
- `set_programming.py` — intra-workout set scheme (warmup/heavy_top/backoff/volume), load increments, next-set recommendations
- `in_workout_review.py` — AI-reviewed next-set suggestions (deterministic first, AI only when suspicious)
- `activity_impact.py` — 12-muscle-group fatigue model with decay, negative fatigue for recovery/mobility, derived readiness
- `fitness_score.py` — 4-pillar composite fitness score (strength 30, cardio 30, consistency 25, recovery 15)
- `cardio.py` — classifies exercises as intervals/steady/easy for conditioning days
- `plan_review.py` — optional AI review of generated plans
- `plan_ai_regenerate.py` — AI-assisted plan modifications via coach chat
- `focus_normalize.py` — focus label normalization to families

### Fatigue System (12 Muscle Groups)
```
chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic
```
- Decay: day 0 = 1.0, day 1 = 0.50, day 2 = 0.25, day 3 = 0.10
- Recovery/mobility days have NEGATIVE fatigue values (actively reduce fatigue)
- Recovery: -0.08 per muscle, -0.10 systemic; Mobility: -0.05 per muscle, -0.08 systemic
- Fatigue floor clamped at 0.0
- Focus auto-correction: backend infers correct focus from exercises performed on workout completion
- Graduated planner response: >=60% proceed, 40-60% downgrade, 20-40% swap focus, <20% force recovery

### Injury System (Three Layers)
1. **Movement pattern blocking** — active injuries hard-block dangerous patterns (e.g., knee blocks squat/lunge)
2. **Recovering mode** — recovering injuries allow exercises at reduced volume instead of full block
3. **Muscle group mapping** — each injury maps to affected muscle groups for fatigue awareness

Coverage: lower_back, knee, shoulder, hip, hamstring, ankle, achilles, elbow, tennis_elbow, golfer_elbow, wrist, chest, neck. Body part picker (not free text) with pre-mapped muscle groups. `InjuryEntry` has: muscleGroups, severity, estimatedRecoveryDays, estimatedRecoveryDate, statusUpdatedAt.

### Nutrition System (AI + Deterministic)
- AI generates meal templates via structured JSON prompts (gpt-4o-mini)
- Deterministic macro solver calculates targets from TDEE
- USDA FoodData Central for food search (AI fallback)
- Meal routines, preserved meals, per-day editing
- `food_quality` classification: keyword-based client-side, category-based on backend plan enrichment
- Meal edits auto-persist to AsyncStorage (survive app kill)
- Saved meals no longer rejected by micros check on reload

### Nutrition Scoring (Client-Side)
- One combined Health Score (activity 50% + nutrition 50%)
- Backward-looking: requires 14 days of data for full confidence
- Scoring pillars: adherence (cal/protein alignment), quality (whole food %, fiber, produce), micro coverage
- Confidence-aware: low confidence scales total score down
- Logging completeness affects confidence, not adherence directly
- Per-day nutrition scores displayed on NutritionCard headers
- Food quality dots: green = whole, red = processed, gray = unknown

### AI Coach (Unified)
- Single chat interface for workout + nutrition questions
- Exercise swaps, meal modifications, injury handling (estimates severity, muscleGroups, estimatedRecoveryDays), goal changes
- Day-level focus changes are deterministic (not AI) via Switch Day button
- Image MIME fix: `_fix_image_mime` detects actual format from magic bytes, re-encodes HEIC via Pillow

## File Structure
```
app/
  _layout.tsx          # Root Stack navigator
  index.tsx            # Auth -> Onboarding -> HomeScreen routing
src/
  screens/             # 7 screens (Auth, Onboarding, Home, ActiveWorkout, EditProfile, Progress, Supplements)
  components/          # 19+ components (WorkoutCard, NutritionCard, LogActivityModal, MealEditModal, etc.)
  utils/               # weightHistory, exerciseImages, mealTracker, workoutHistory, nutritionScore, exerciseGuide
  constants/           # goalConfig, muscleLibrary, muscleImages, theme (27 themes)
  services/api.ts      # All backend API calls
  hooks/useMetaData.ts # Cached metadata (foods, equipment, goals, paces)
backend/
  app/
    main.py            # FastAPI with startup hooks (exercise images, food enrichment, fatigue backfill)
    models.py          # SQLModel tables
    routers/           # auth, workouts, meals, meta, profile, ai/ (plans, chat, scanning, progression)
    services/workout/  # 26 files: planner, fatigue, recipes, prescriptions, goals, set programming, fitness score, etc.
    services/nutrition/ # meal assembly, calorie calc, plan review, nutrition score
    services/usda_fdc.py # USDA FoodData Central client
  tests/               # 10 test modules registered in run_all.py
```

## UI Layout

### Workout Tab Sub-tabs
- **Plan** — weekly workout plan with day cards
- **Library** — merged Exercises + Muscles with toggle
- **Settings** — equipment, injuries, preferences

### Meals Tab Sub-tabs
- **Plan** — daily meal plan with per-day nutrition scores
- **Foods** — food search + targets (merged from separate Targets tab)
- **Supps** — supplements

### Key UI Features
- Exercise dislike (thumbs down on active workout, excludes from future plans)
- Recovery badge expandable with per-muscle bars
- Resume workout: themed modal, only shows if sets were logged
- Rest timer: AI recommendation badge (16px bold)
- Stretches/bodyweight exercises hide weight column
- AppState listener catches up timers on foreground return
- Workout start time persists for accurate elapsed on resume
- History export moved from Profile to Progress > History tab
- Barcode scanner: ref-based lock prevents multiple scans
- Routine overlay skipped for saved/remote plans (preserves user edits)
- Spin Class added as cardio subtype; Pilates label fixed
- Manual activities show full detail in history (e.g., "Recovery - Sauna (easy)")

## Dev Commands
```bash
docker compose up -d                          # Start backend + DB
docker compose build backend && docker compose up -d backend  # Rebuild
npx expo start --clear                        # Start frontend
docker compose logs -f backend                # Backend logs
docker exec thallo-pg psql -U thallo -d thallo  # DB shell
make test                                     # Run all backend tests (10 modules)
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
- AI is gated — used only for nutrition plans, coach chat, food scanning, in-workout set review (when suspicious)
- Fatigue is muscle-group based — 12 dimensions, not pattern-based; recovery/mobility days have negative (restorative) fatigue
- Injuries operate at three layers: pattern blocking, recovering mode (reduced volume), muscle group fatigue awareness
- Day focus changes are UI buttons, not AI; focus auto-corrected from exercises on completion
- Food data: USDA first, AI fallback. Exercise search: wger first, AI fallback
- Nutrition scoring is client-side from planned meals; one combined Health Score (activity 50% + nutrition 50%)
- Recovery days are separate from conditioning — Zone 2 / intervals are training stress, not recovery
- Exercise dislikes persist and are excluded from future plan generation

## Supported Goals
fat_loss, muscle_gain, body_recomp, strength, endurance, athletic_performance, hyrox, toning, maintain, general_health

## Supported Splits
PPL, Upper/Lower, Full Body, PPL+UL hybrid, Bro split (auto-selected based on goal + days)
