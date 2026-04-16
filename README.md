# WorkoutPal - Fitness & Nutrition Planning App

A simple React Native + Expo fitness and nutrition planning application built with TypeScript.

## Project Structure

```
WorkoutPal/
├── src/
│   ├── screens/
│   │   ├── OnboardingScreen.tsx    # User onboarding with form inputs
│   │   └── HomeScreen.tsx          # Main app showing daily plan
│   ├── components/
│   │   ├── WorkoutCard.tsx         # Displays workout details
│   │   └── NutritionCard.tsx       # Displays nutrition targets & meals
│   ├── navigation/
│   │   └── RootNavigator.tsx       # React Navigation setup
│   ├── types/
│   │   └── index.ts                # TypeScript interfaces & types
│   └── utils/
│       └── planGenerator.ts        # Mock plan generation logic
├── App.tsx                         # Main app component
├── app.json                        # Expo configuration
├── package.json                    # Project dependencies
├── tsconfig.json                   # TypeScript configuration
└── babel.config.js                 # Babel configuration
```

## File Purpose Reference

### Screens
- **OnboardingScreen.tsx**: Multi-step form where users input their fitness goal, training days/week, available equipment, and favorite foods
- **HomeScreen.tsx**: Displays "Today's Plan" with workout and nutrition information

### Components
- **WorkoutCard.tsx**: Renders individual workout day with exercises, sets, reps, and rest periods
- **NutritionCard.tsx**: Shows nutrition targets and meal suggestions for the day

### Navigation
- **RootNavigator.tsx**: Sets up React Navigation stack. Shows Onboarding first, then Home after profile creation

### Utils
- **planGenerator.ts**: Generates mock workout plans (full-body, PPL, upper-lower splits based on days available) and nutrition plans with calorie/protein targets

### Types
- **index.ts**: Defines all TypeScript interfaces (UserProfile, Exercise, WorkoutDay, NutritionTargets, etc.)

## Setup Instructions

### 1. Prerequisites

First, install Node.js and npm on your machine:
- **Windows**: Download from https://nodejs.org/ (LTS recommended)
- **Mac**: `brew install node`
- **Linux**: `sudo apt install nodejs npm`

Verify installation:
```bash
node --version
npm --version
```

### 2. Install Expo CLI

```bash
npm install -g expo-cli
```

### 3. Install Dependencies

Navigate to the project folder and install dependencies:

```bash
cd e:\WorkoutPal
npm install
```

This installs all packages defined in `package.json`.

### 4. Run the App

Start the Expo development server:

```bash
npm start
```

This will show a menu with options:

```
i - run on iOS simulator
a - run on Android emulator
w - run on web
```

**Choose an option:**

- **Web (Fastest for testing)**: Press `w` to open in your browser
- **iOS**: Press `i` (requires Mac with Xcode)
- **Android**: Press `a` (requires Android Studio)

### 5. Test on Phone (Optional)

Download the **Expo Go** app from your phone's app store, then scan the QR code shown in the terminal.

## How the App Works

### Onboarding Flow
1. User selects fitness goal (Fat Loss / Muscle Gain / General Fitness)
2. Enter training days per week (1-7)
3. Select available equipment
4. Input favorite foods (optional)
5. User profile is saved to device storage

### Home Screen
- Displays today's workout with exercises and reps
- Shows nutrition targets (calories, protein, carbs, fat)
- Displays meal suggestions for the day
- Allows cycling through different workout days

## Key Features

✅ **TypeScript**: Fully typed for better development experience
✅ **Local Storage**: User profile persisted on device using AsyncStorage
✅ **Mock Data**: Generates realistic plans without API
✅ **Responsive UI**: Clean, beginner-friendly interface
✅ **Navigation**: Simple onboarding → home flow

## Workout Plans Generated

Based on days per week available:
- **1-3 days**: Full body split (3 days)
- **4-5 days**: Push/Pull/Legs split (3 days shown)
- **6-7 days**: Upper/Lower split (4 days)

## Nutrition Calculation

Simple estimates (in production, would need more user data):
- Fat Loss Goal: ~1800 calories/day
- Muscle Gain Goal: ~2500 calories/day
- Protein: 0.8-1g per pound of bodyweight
- Meals split: 25% breakfast, 35% lunch, 40% dinner

## Next Steps for Extension

- Add backend API for personalized plans
- Implement exercise tracking (sets/reps logged per session)
- Add progress photos and measurements
- Integrate with health APIs (Apple Health, Google Fit)
- Add meal logging and calorie tracking
- Social features (share progress, find workout buddies)
- Authentication system

## Troubleshooting

### Port already in use
If you get "Port 8081 already in use":
```bash
expo start -c
```
(The `-c` flag clears cache and can help)

### Dependencies not installing
```bash
rm -rf node_modules package-lock.json
npm install
```

### TypeScript errors
Make sure `tsconfig.json` is correct by checking `src/` is in `include`

## Resources

- [React Native Docs](https://reactnative.dev/)
- [Expo Documentation](https://docs.expo.dev/)
- [React Navigation Docs](https://reactnavigation.org/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## AI Evaluation (Backend)

This document snapshots every place an LLM is called in the backend as of the most recent audit. Use it to decide which calls to keep, gate, or rewrite. Frontend has **zero** direct LLM calls — every AI round-trip goes through the backend.

All calls route through `backend/app/routers/ai/utils.py` helpers (`_build_chat_kwargs`, `_chat_create`, `_extract_json`) and an OpenAI client initialized from `OPENAI_API_KEY`. Model selection is env-driven via `model_chat()`, `model_plan_generation()`, `model_plan_update()`, `model_meal_parsing()` — each defaults to `gpt-4o-mini` if the corresponding env var isn't set.

### 1. Plan generation (core flow)

| # | Location | Purpose | Sync? |
|---|---|---|---|
| 1 | `plans.py::_generate_trainer_note` | Writes the 120–180 word trainer note after the deterministic plan is built. Reads `plan["_recent_completed"]` so it can reference yesterday's session. | `asyncio.to_thread` |
| 1b | `plans.py::_generate_nutritionist_note` | Grounded nutritionist note generated AFTER nutrition review + macro normalization. Reads final per-meal macros + reviewer patches so it can reference the actual numbers the user sees and acknowledge any AI fixes. Runs in parallel with the trainer note path. | `asyncio.to_thread` |
| 2 | `services/nutrition/meal_assembler.py::call_skeleton_ai` | AI picks meal name skeletons + supplement stack; the deterministic solver sizes portions to macros. Also emits a fallback nutritionist note that `_generate_nutritionist_note` overwrites on success. | `asyncio.to_thread` |

The deterministic workout planner (`services/workout/planner.py`) handles day-by-day structure, exercise selection, load recommendations, and set schemes with **no AI involvement**. AI only writes the trainer note that describes the already-built plan.

### 2. Plan review + regenerate (recent additions, feature-flagged)

| # | Location | Purpose | Gate |
|---|---|---|---|
| 3 | `services/workout/plan_review.py::review_plan` | Audits the deterministic workout plan against goal + 3-day history, returns structured patches (swap / remove / add / change_sets_reps / change_focus) or approves. | `PLAN_REVIEW_ENABLED=1` env var |
| 4 | `services/workout/plan_ai_regenerate.py::regenerate_plan_with_ai` | When review flags `status="modify"` or the contradiction detector triggers on "ok-with-complaints" notes, rebuilds the full plan from scratch using the equipment-filtered catalog. | Fires only after #3 flags an issue |
| 4a | `services/nutrition/plan_review.py::review_nutrition_plan` | Per-template meal-plan reviewer. Catches per-item macro nonsense ("50 cal ribeye 8oz"), allergen leaks, diet-preference violations, meal totals that don't match their items. Returns `adjust_meal_macros` / `adjust_item_macros` / `swap_food` / `remove_item` patches. Runs **before** the macro normalizer so fixes propagate through the scale-to-target pass. Writes a `nutrition_validation` sidecar onto each template so we don't re-review the same plan. | `NUTRITION_REVIEW_ENABLED=1` env var |

All three are **off by default**. Set `PLAN_REVIEW_ENABLED=1` and/or `NUTRITION_REVIEW_ENABLED=1` in the backend env to enable. When enabled, every plan generation attaches a `_debug.review` sidecar (workouts) and/or `nutrition_validation` per-template tags (nutrition) so the frontend can log the brief + verdict + patches.

### 3. In-workout next-set recommendation

| # | Location | Purpose | Gate |
|---|---|---|---|
| 5 | `services/workout/in_workout_review.py::reviewed_next_set_recommendation` | Runs the deterministic `recommend_next_set` first, then escalates to AI only when `is_suspicious()` flags (feel-vs-reps conflict, big overshoot/undershoot, first session, deterministic disagrees with perceived effort). | Rule-based suspicion filter |
| 6 | `routers/ai/progression.py::/recommend-weight` | The endpoint `ActiveWorkoutScreen` calls after each logged set. 100% deterministic anchor pipeline; optionally wraps through #5. Hides UI until the user logs "how it felt". | `feel` required before response renders |

### 4. Trainer / nutritionist chat

| # | Location | Purpose |
|---|---|---|
| 7 | `routers/ai/chat.py::/ai/trainer-question` | Open-ended Q&A with plan / profile / progress / history context. Can return full updated workout or nutrition plans when the user asks for changes. Intent-detection regex safety net forces `needs_plan_update=true` when the AI describes a change in prose but forgets the flag. |
| 7b | `routers/ai/chat.py::/ai/workout-question` | Lighter-weight companion endpoint scoped to a single active/next workout (exercise swap, rep-range tweak, "is this the right exercise for me" Q&A) without pulling the full plan/profile/history context. Used from the ActiveWorkoutScreen. |
| 8 | `routers/ai/chat.py::/ai/smoke-test` | Dev-only OpenAI connectivity ping. |

### 5. Food / nutrition / scanning (vision + text)

All live in `routers/ai/scanning.py`:

| # | Endpoint | Purpose |
|---|---|---|
| 9 | `analyze_food_photo` | Macros + 31-field micronutrient panel from a single meal photo |
| 10 | `scan_foods_photo` | Identifies 3–5 individual foods per image with per-serving macros |
| 11 | `food_nutrition_search` | Free-text nutrition lookup ("100g chicken breast") |
| 12 | `generate_meal_instructions` | On-demand prep instructions / recipe for one meal |
| 13 | `get_supplement_info` | Evidence-based supplement lookup by name |
| 14 | `get_supplement_from_photo` | Supplement identification from a label photo |
| 15 | `scan_equipment_photo` | Identifies gym equipment from a photo (onboarding) |
| 16 | `analyze_form_photo` | Form coaching cues from an exercise photo |
| 17 | `body_scan` | Body composition estimate from a physique photo |
| 18 | `exercise_ai_search` | Natural-language exercise search ("lower chest dumbbell") with equipment/injury filtering |

### 6. Weekly check-in coaching

| # | Location | Purpose |
|---|---|---|
| 19 | `services/coach/checkin_ai.py::call_checkin_llm` | Decides one of `coach_only` / `small_adjust` / `deep_review` / `leave_alone` / `ask_more` for the weekly check-in flow. **Currently the weakest call** — doesn't yet receive the structured `WorkoutSession` + `ExerciseSet` data, so its "analysis" is mostly ungrounded prose. Highest-leverage rewrite target. |

### 7. Post-workout summary + free-form history parsing

| # | Location | Purpose |
|---|---|---|
| 20 | `routers/ai/progression.py::/ai/workout-summary` | AI-written recap generated after the user finishes a workout: highlights top sets, PRs, volume vs. last session, and one coaching cue for next time. Reads the just-completed `WorkoutSession` rows plus the previous comparable session. |
| 21 | `routers/ai/plans.py::/ai/parse-workouts` | Converts free-form workout descriptions ("I did 3 sets of bench, then squats, then went for a 20 min run") into structured `WorkoutSession` + `ExerciseSet` rows so the user can backfill unlogged history. One-shot JSON extraction call, used from the onboarding / manual-entry path. |

### Feature flags & gating

| Gate | Effect |
|---|---|
| `OPENAI_API_KEY` missing | All calls degrade gracefully: plan review returns `status="ok"` with error note; regenerate returns `None`; scanning endpoints return 503. |
| `PLAN_REVIEW_ENABLED=1` | Enables workout plan review (#3) + AI regenerate (#4). Off by default. |
| `NUTRITION_REVIEW_ENABLED=1` | Enables per-template nutrition plan review (#4a). Off by default. Runs once per template; `nutrition_validation.ok=true` short-circuits re-review. |
| `MODEL_PLAN_GENERATION`, `MODEL_PLAN_UPDATE`, `MODEL_CHAT`, `MODEL_MEAL_PARSING`, `MODEL_CHECKIN` | Per-category model overrides. All default to `gpt-4o-mini`. |
| `is_suspicious()` rule-based filter | Controls when the in-workout AI review actually fires — typical workouts see zero AI calls per session. |

### Cost profile (typical request)

All defaults are `gpt-4o-mini`: **$0.15 / 1M input tokens, $0.60 / 1M output tokens**. Numbers below are per-call averages measured from recent prod logs.

| # | Call | Input tok | Output tok | $/call | Gate |
|---|---|---|---|---|---|
| 1 | Trainer note | ~2,000 | ~400 | $0.0005 | always |
| 1b | Grounded nutritionist note | ~2,500 | ~400 | $0.0006 | always |
| 2 | Meal skeletons + supplement stack | ~3,000 | ~2,000 | $0.0017 | always |
| 3 | Workout plan review | ~4,000 | ~800 | $0.0011 | `PLAN_REVIEW_ENABLED` |
| 4 | AI regenerate (fires ~20% of reviewed plans) | ~5,000 | ~3,000 | $0.0026 | after #3 flags |
| 4a | Nutrition plan review (× 3 templates) | ~3,000 | ~600 | $0.0009 each → **$0.0027/gen** | `NUTRITION_REVIEW_ENABLED` |
| 5 | In-workout next-set review | ~1,500 | ~300 | $0.0004 | `is_suspicious()` |
| 7 | Trainer chat (phase 1) | ~3,000 | ~500 | $0.0008 | per message |
| 7ph2 | Trainer chat plan rebuild (phase 2, ~25% of messages) | ~5,000 | ~3,000 | $0.0026 | per message |
| 7b | Workout-question (scoped to one exercise) | ~1,500 | ~400 | $0.0005 | per message |
| 9 | Food photo scan (vision) | ~1,500 + image | ~800 | $0.0011 | per scan |
| 10 | Multi-food photo scan (vision) | ~1,500 + image | ~1,200 | $0.0013 | per scan |
| 11 | Food nutrition search (text) | ~800 | ~400 | $0.0004 | per search |
| 12 | Meal instructions / recipe | ~1,000 | ~600 | $0.0005 | per request |
| 13 | Supplement info / label photo | ~1,200 + image | ~500 | $0.0008 | per request |
| 15 | Equipment scan (vision) | ~1,500 + image | ~400 | $0.0008 | per scan |
| 16 | Form analysis (vision) | ~1,500 + image | ~500 | $0.0009 | per scan |
| 17 | Body scan (vision) | ~1,500 + image | ~600 | $0.0010 | per scan |
| 18 | Exercise AI search | ~1,500 | ~400 | $0.0005 | per search |
| 19 | Weekly check-in | ~2,000 | ~400 | $0.0005 | weekly |
| 20 | Post-workout AI summary | ~2,500 | ~500 | $0.0007 | per finished workout |
| 21 | Parse free-form workouts | ~1,500 | ~1,000 | $0.0008 | per backfill entry |

**Per-event totals:**

| Event | Calls (all flags off) | $/event off | Calls (all flags on) | $/event on |
|---|---|---|---|---|
| Plan generation (workout-only) | 1 | $0.0005 | 3 (trainer + review + 0.2× regen) | ~$0.0021 |
| Plan generation (full plan) | 3 (trainer + nutritionist + skeletons) | $0.0028 | 7–8 (+ workout review + 0.2× regen + 3× nutrition review) | ~$0.0082 |
| Active workout (12 sets, ~2 suspicion fires + finish summary) | 1–3 | $0.0007–$0.0015 | same | same |
| Trainer chat question (main trainer) | 1–2 | $0.0008–$0.0034 | same | same |
| Workout-question (active workout screen) | 1 | $0.0005 | same | same |
| Post-workout summary | 1 | $0.0007 | same | same |
| Weekly check-in | 1 | $0.0005 | same | same |
| Backfill parse (per free-form entry) | 1 | $0.0008 | same | same |

### Estimated monthly cost per active user

Assuming a moderately active user: 1 full plan gen, 4 plan regens/tweaks via trainer chat, 12 workout sessions (each with ~2 suspicion fires + 1 post-workout summary), 20 main trainer chat messages, 10 active-workout questions, 60 food photo scans, 30 food searches, 10 meal-instruction requests, 4 weekly check-ins, 5 backfill parses during onboarding, 2 body scans, 1 equipment scan, 3 form-check photos.

| Category | Calls/mo | $/mo (flags off) | $/mo (flags on) |
|---|---|---|---|
| Plan generation (1 full + 4 rebuilds) | 5 | ~$0.014 | ~$0.041 |
| Active workout next-set reviews (24) | 24 | ~$0.010 | ~$0.010 |
| Post-workout summaries (12) | 12 | ~$0.008 | ~$0.008 |
| Main trainer chat (20 msgs, ~5 rebuild) | 25 | ~$0.029 | ~$0.029 |
| Workout-question chat (10 msgs) | 10 | ~$0.005 | ~$0.005 |
| Food photo scans (60) | 60 | ~$0.066 | ~$0.066 |
| Food search + meal instructions (40) | 40 | ~$0.017 | ~$0.017 |
| Body / equipment / form scans (6) | 6 | ~$0.006 | ~$0.006 |
| Weekly check-ins (4) | 4 | ~$0.002 | ~$0.002 |
| Backfill parse (onboarding, 5) | 5 | ~$0.004 | ~$0.004 |
| **Total / active user / month** | **~191** | **~$0.16** | **~$0.19** |

Enabling `NUTRITION_REVIEW_ENABLED` adds roughly **$0.003 per full-plan generation** (3 templates × $0.0009). For a user who regenerates their plan weekly that's ~$0.013/mo extra. Enabling `PLAN_REVIEW_ENABLED` adds ~$0.002 per plan gen on the base review call plus ~$0.0005 amortized from the 20% regen hit. The new grounded nutritionist note (#1b) adds ~$0.0006 per generation. **Both flags on, expect total AI cost per active user to stay well under $0.25/mo.**

Heavy power users (daily food scans, multiple trainer chats per day, frequent plan tweaks, regular body/form scans) can realistically hit **$0.80–$1.80/month**. The dominant cost line for any user is image-bearing scan calls (food photos, body scans, form analysis) — not text chat. Watch photo scan frequency first if a user looks expensive.

### Session duration & warm-up contract

When the user sets `workoutDurationMinutes` (e.g. 60 min), that budget is passed into `PlannerInputs.session_minutes` and drives `density_adjust_slots` in `services/workout/slots.py`. The per-slot cost table already bakes **~5 minutes of warm-up / ramp-up time** into the `primary=12` lifting cost — so the 60-minute budget is inclusive of warm-up, not on top of it. The frontend `WorkoutCard` duration estimator matches this contract (no extra warm-up padding) and displays the hint *"Includes ~5 min warm-up time at the start of the session"* so the user doesn't plan for 65 minutes when the card says ~60. The trainer note prompt also explicitly mentions that warm-up is included so the AI doesn't tell the user to add extra time on top.

**Common bug watch:** if a plan appears to estimate at ~30 min for a 60-min budget, it's almost always the frontend estimator mis-parsing timed-exercise reps (e.g. zone 2 cardio at `"30-45 min"` being read as a 45-second set). Fixed in `WorkoutCard.tsx::parseWorkSecondsPerSet`.

### What's worth rewriting next

1. **#19 check-in AI** — replace free-form prose with structured commitments (per-exercise "+5 lb next week"-style deterministic goals generated from `recommend_next_session_load`), a weekly evaluator that computes hit / partial / missed against actual logged sets, and an AI call whose only job is to phrase the verdicts.
2. **Trainer note grounding** — currently history-aware but still free-form. Could be upgraded to reference the same structured commitments.
3. **Suspicion filter tuning** — `is_suspicious()` currently triggers on ~20% of sets in practice. Some triggers (first session of exercise) may be too aggressive; profile in production and tighten.

## License

MIT
