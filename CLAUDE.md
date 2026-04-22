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
- `goal_profiles.py` — maps goals to training mix (strength/hypertrophy/power/conditioning/mobility/recovery), allowed archetypes, planner mode (lifting, lifting_plus_cardio, strength, endurance, athletic, hyrox, maintain, mobility, recovery). Longevity / healthy_aging / heart_health route to the general_health profile via `_PROFILE_OVERRIDES`
- `weekly_recipe.py` — generates weekly archetype sequence with intensity spacing; separate recovery allocation from conditioning
- `focus_profiles.py` — FocusProfile (split_bias, volume_bias, min_exposure_days) for focused_muscle inputs; wired into `pick_split`, `archetype_to_slots`, the volume-bias pass, focus backfill, and audit log
- `focus_normalize.py` — focus label normalization; exposes `_FINE_TO_COARSE` so the recent-focus rotation can collapse families (push/pull/legs) to coarse buckets (upper_body/lower_body) when the caller passes mixed granularities
- `day_templates.py` — picks splits, maps archetypes to exercise slots
- `slots.py` — slot definitions with density trimming
- `planner.py` — core orchestrator: slot filling, scoring, exercise selection, injury pattern blocking, dislike filtering; `build_planner_exercise` is the canonical schema helper every code path (planner + AI regenerate + patch rehydration) calls to produce an exercise dict (camelCase `restSeconds`, `setScheme`, `targetWeightLbs`, recommendation meta). Also houses `generate_recovery_day()` and `generate_mobility_day()` which scale exercises to `session_minutes`
- `prescriptions.py` — sets/reps/rest per archetype and slot role; dispatches lifting/cardio/mobility/recovery/hybrid
- `set_programming.py` — intra-workout set scheme (warmup/heavy_top/backoff/volume), load increments, next-set recommendations
- `in_workout_review.py` — AI-reviewed next-set suggestions (deterministic first, AI only when suspicious)
- `activity_impact.py` — 12-muscle-group fatigue model with decay, negative fatigue for recovery/mobility, derived readiness; includes Active activities (yard work, chopping wood, moving, gardening, cleaning, construction, shoveling, playing w/ kids, dancing) and expanded sports (pickleball, surfing, skiing)
- `fitness_score.py` — 4-pillar composite fitness score (strength 30, cardio 30, consistency 25, recovery 15)
- `cardio.py` — classifies exercises as intervals/steady/easy for conditioning days
- `plan_review.py` — optional AI review of generated plans; `build_plan_brief` now includes `user_preferred_split` + `skipped_days_7d` so the reviewer prompt can reference them; `_rehydrate_derived_fields` rebuilds setScheme/targetWeightLbs/recommendation meta on any patched exercise (swap/add/sets_reps) so AI-touched exercises stay schema-canonical
- `plan_ai_regenerate.py` — AI-assisted plan modifications via coach chat; emits through `build_planner_exercise` too

### Weekly Recipe Repair + Rotation
- `_repair_adjacent_duplicates` — three-tier sweep. Tier A: strict safe swap (no new conflicts). Tier B: net-reducing swap (may create a transient conflict elsewhere). Tier C: forced triple-break — guarantees no 3-in-a-row same family survives even in pathological rotations. Runs after interleaving cardio AND after recent-focus rotation, and again after intensity-spacing
- Recent-focus rotation uses fine families (push/pull/legs) when available, coarse buckets otherwise (auto-detected)
- U/L forced-even-lift-days rule: when `_lifting_plus_cardio_recipe` lands on an odd number of lift days with U/L split, it trades a recovery day (or one cardio day) for a lift so Upper/Lower stay balanced. Fat-loss 6-day example: 3 lifts + 2 cond + 1 recov → 4 lifts + 2 cond

### Fatigue System (12 Muscle Groups)
```
chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic
```
- Decay: day 0 = 1.0, day 1 = 0.50, day 2 = 0.25, day 3 = 0.10
- Recovery/mobility days have NEGATIVE fatigue values (actively reduce fatigue)
- Two-pass rolling fatigue: Pass 1 accumulates positive fatigue from workouts; Pass 2 applies recovery (max 1 session per day, 15% of current fatigue, capped at 0.15) — prevents recovery stacking
- Recovery: -0.08 per muscle, -0.10 systemic; Mobility: -0.05 per muscle, -0.08 systemic
- Fatigue floor clamped at 0.0
- Focus auto-correction: `_infer_focus_from_muscles()` derives correct focus from exercises performed on workout completion
- Graduated planner response: >=60% proceed, 40-60% downgrade, 20-40% swap focus, <20% force recovery
- Nutrition recovery integration: fatigue endpoint returns `nutrition_context` with protein status and coaching message (4 tiers: excellent 130g+/-5% bonus, good 100g+/-3% bonus, low 50-99g/+3% penalty, very low <50g/no change)

### Multiple Completions Per Day
- Workout completion upsert key changed from (user, date) to (user, date, focus)
- Legs morning + sauna evening = 2 separate rows, both affect fatigue correctly
- Prevents second activity from overwriting the first

### Recovery/Mobility Day Scaling
- `generate_recovery_day()` and `generate_mobility_day()` scale to `session_minutes`
- Recovery: 20min core stretches only, 30min +pigeon/forward fold, 40min +easy walk, 50min +quad/shoulder/dead hang, 60min all
- Mobility: 20min 7 drills, 35min +couch stretch/pull-aparts, 45min +straddle/wall slides/dead hang, 55min +butterfly/spinal twist/savasana

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

### Meal History System
- `backend/app/services/nutrition/meal_history.py` — 6 functions: `log_meal_from_plan`, `get_meal_history`, `get_rolling_averages`, `get_common_meals`, `get_nutrition_patterns`, `get_meal_insights`
- 5 API endpoints: `POST /meals/log-checked`, `GET /meals/history`, `GET /meals/averages`, `GET /meals/common`, `GET /meals/insights`
- Client auto-logs meals when checked off (fire-and-forget to backend)
- Uses existing `meals` + `meal_items` DB tables (no new tables needed)
- Unlocks: rolling nutrition summaries, repeated meal detection, behavior patterns, coaching insights
- Common meals shown as "YOUR FAVORITES" horizontal scroll on Foods sub-tab
- Meal history now feeds the nutrition skeleton prompt: `build_nutrition_context(db, user_id)` pulls rolling averages + common meals and `format_for_prompt` emits them as context lines, so AI meal plans can lean on the user's actual eating patterns

### Nutrition Scoring
- One combined Health Score (activity 50% + nutrition 50%) on Progress screen
- Health Score uses real meal data from `getMealAverages(authToken, 14)` when available (2+ days)
- Nutrition sub-score: calorie adherence (40pts) + protein adherence (35pts) + logging consistency (25pts)
- Falls back to `dietScore.total` when insufficient data
- Backward-looking: requires 14 days of data for full confidence
- Scoring pillars: adherence (cal/protein alignment), quality (whole food %, fiber, produce), micro coverage
- Per-day nutrition scores displayed on NutritionCard headers
- Score detail view: tappable card on NutritionCard with adherence/quality/micro bars, cal/protein totals, wins/improvements, food quality legend
- Tags use actual ratio for directional messaging: "Calories 20% under target — add 440 cal" instead of generic
- Calorie: within +/-10% = "on target", otherwise shows % over/under with actionable gap
- Protein: >=90% = "on target", otherwise shows exact gram gap

### AI Coach (Unified)
- Single chat interface for workout + nutrition questions
- Exercise swaps, meal modifications, injury handling (estimates severity, muscleGroups, estimatedRecoveryDays), goal changes
- Day-level focus changes are deterministic (not AI) via Switch Day button — picker shows ALL options with a readiness chip + conflict warning instead of filtering the list (allow-with-warnings)
- Image MIME fix: `_fix_image_mime` detects actual format from magic bytes, re-encodes HEIC via Pillow

### History Plumbing
- `prev_focuses` — raw focus labels from recent completions, surfaced on the single-day generator and threaded through the client. Normalized to `recent_focus_buckets` (coarse) and `recent_focus_families` (fine: push/pull/legs) which both feed `generate_weekly_recipe` — so a user who just hit push yesterday gets rotated away from push on day 0
- History brief includes `user_preferred_split` + `skipped_days_7d` for reviewer context

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
  services/api.ts      # All backend API calls (includes getMealAverages, getCommonMeals, logCheckedMeal)
  hooks/useMetaData.ts # Cached metadata (foods, equipment, goals, paces)
backend/
  app/
    main.py            # FastAPI with startup hooks (exercise images, food enrichment, fatigue backfill)
    models.py          # SQLModel tables
    routers/           # auth, workouts, meals, meta, profile, ai/ (plans, chat, scanning, progression)
    services/workout/  # 26 files: planner, fatigue, recipes, prescriptions, goals, set programming, fitness score, etc.
    services/nutrition/ # 8 files: meal assembly, calorie calc, plan review, nutrition score, meal history
    services/usda_fdc.py # USDA FoodData Central client
  tests/               # 12 test modules (~212 tests) registered in run_all.py (test_planner_schema + test_history_plumbing plumb the canonical-schema/prev_focuses contracts; `audit_generators.py` is a throwaway sweep, not registered)
```

## UI Layout

### Workout Tab Sub-tabs
- **Plan** — weekly workout plan with day cards
- **Library** — merged Exercises + Muscles with toggle
- **Settings** — equipment, injuries, preferences

### Meals Tab Sub-tabs
- **Plan** — daily meal plan with per-day nutrition scores
- **Foods** — food search + targets + "YOUR FAVORITES" horizontal scroll of common meals
- **Supps** — supplements

### UI Helpers + Conventions
- `shouldHideWeight` / `shouldHideReps` (src/utils/exerciseDisplay.ts) — single source of truth for bodyweight + stretch exercise UI. Active workout, history, plan cards all call the same helper so columns hide consistently
- Day card muscle chips: read `primary_muscle` directly from the exercise now (not re-classified). Mobility / recovery days collapse to a single "Mobility" or "Recovery" label instead of listing every muscle
- Switch Day picker: every target focus is selectable; each shows a readiness chip and a conflict warning when current fatigue or skip history would make it a poor pick. The planner still swaps in the chosen focus and re-runs adjacency repair

### Onboarding / Goal Flow
- ACID-style finalize: `user_username` and `LAST_USER_ID_KEY` writes are deferred to the end of the flow so a crash mid-onboarding won't leave the app in a half-registered state
- Pace picker lives on the goal step (conservative / moderate / aggressive) next to the goal chat input
- Auto-split reason: when the planner auto-picks a split, the UI shows the rationale (e.g. "4 days intermediate muscle_gain → Upper/Lower")
- ETA normalization: `GOAL_TO_BUCKET` (src/utils/goalEstimate.ts) maps raw goal ids to the calorie/timeline bucket used for ETA math

### Key UI Features
- Exercise dislike (thumbs down on active workout, excludes from future plans)
- Recovery badge expandable with per-muscle bars; "Overall Load" label (replaces "CNS / Systemic")
- Nutrition insight shown in recovery card when expanded (colored message with icon from `nutrition_context`)
- Resume workout: themed modal, only shows if sets were logged
- Rest timer: AI recommendation badge (16px bold)
- Stretches/bodyweight exercises hide weight column (via `shouldHideWeight`)
- AppState listener catches up timers on foreground return
- Workout start time persists to AsyncStorage for accurate elapsed on resume
- History export: PDF via expo-print with themed HTML (white bg, dark text, Thallo logo, two-column card layout); filename `{username}_{date}_history.pdf`; falls back to HTML file sharing, then RN Share for text; located in Progress > History tab
- Barcode scanner: ref-based lock prevents multiple scans
- Routine overlay skipped for saved/remote plans (preserves user edits)
- Spin Class added as cardio subtype; Pilates label fixed
- Manual activities show full detail in history (e.g., "Recovery - Sauna (easy)")
- Active activities category in LogActivityModal: Yard Work, Chopping Wood, Moving/Lifting, Gardening, House Cleaning, Construction, Shoveling, Playing w/ Kids, Dancing
- Sport expanded: Pickleball, Surfing, Skiing added

## Dev Commands
```bash
docker compose up -d                          # Start backend + DB
docker compose build backend && docker compose up -d backend  # Rebuild
npx expo start --clear                        # Start frontend
docker compose logs -f backend                # Backend logs
docker exec thallo-pg psql -U thallo -d thallo  # DB shell
make test                                     # Run all backend tests (10 modules, 183 tests)
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
- Two-pass fatigue prevents recovery stacking — max one recovery session per day, proportional to existing fatigue
- Multiple completions per day supported — upsert key is (user, date, focus), not (user, date)
- Injuries operate at three layers: pattern blocking, recovering mode (reduced volume), muscle group fatigue awareness
- Day focus changes are UI buttons, not AI; focus auto-corrected from exercises on completion
- Food data: USDA first, AI fallback. Exercise search: wger first, AI fallback
- Nutrition scoring uses real meal history when available (2+ days), falls back to planned meals
- Recovery days are separate from conditioning — Zone 2 / intervals are training stress, not recovery
- Recovery/mobility days scale to session_minutes (20-60 min progressive exercise additions)
- Exercise dislikes persist and are excluded from future plan generation
- Meal history auto-logged on check-off, powers rolling averages, common meals, and coaching insights
- Plan generation loop: staleness check clears markers >5 min old; fresh day persisted to AsyncStorage

## Supported Goals
fat_loss, muscle_gain, body_recomp, strength, endurance, athletic_performance, hyrox, toning, maintain, general_health, longevity, flexibility, stress_relief (longevity + healthy_aging + heart_health route to general_health profile via `_PROFILE_OVERRIDES` in `goal_profiles.py`; flexibility / stress_relief have dedicated mobility + recovery profiles)

## Supported Splits
PPL, Upper/Lower, Full Body, PPL+UL hybrid, Bro split (auto-selected based on goal + days)
