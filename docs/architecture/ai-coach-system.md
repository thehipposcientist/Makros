# AI Coach System — Architecture

Last synced from app state: 2026-04-29

## Overview

Three coaches + one deterministic intent router. No AI in workout plan generation.

## Model Routing

- `MODEL_CHAT` defaults to `gpt-4o-mini` for trainer chat, in-workout coach, and most structured text flows.
- `MODEL_IMAGE` defaults to `gpt-5.4-mini`, but only for the dedicated image-analysis routes in `routers/ai/scanning.py`.
- This means the 2026-04-29 image-model cost increase is scoped to scan/photo-analysis features, not the main coach-chat surfaces.

## 1. Home Trainer (unified workout + nutrition)

- **Trigger**: chat input on HomeScreen.
- **Endpoint**: `POST /ai/trainer-question` → `routers/ai/chat.py::ask_trainer_question`.
- **Model**: `MODEL_CHAT` (env var, default gpt-4o-mini).
- **Two-phase**: Phase 1 = deterministic intent classification OR full LLM. Phase 2 = re-call for structured plan generation when `needs_plan_update=true` and plan not returned.
- **Context**: slimProfile + full workoutPlan + nutritionPlan + scheduleMapping + progress (sessionsLast30d, recentDays, last-6 workoutHistory) + foodsAvailable + injuries + last-6 chat turns + optional photo + userContext (last 10 activity-log entries).
- **Response shape**: `{answer, action_items, needs_plan_update, safety_note, updated_goal?, updated_macros?, updated_workout_plan?, updated_nutrition_plan?, updated_injuries?, logged_workouts?, injury_clarification_needed?}`.
- **Persistence**: none on backend. Plan deltas held in `PendingPlanUpdate` client state until user taps Apply.

## 2. In-Workout Coach

- **Trigger**: chat drawer on ActiveWorkoutScreen (Pro-gated).
- **Endpoint**: `POST /ai/workout-question`.
- **Model**: `MODEL_CHAT` (default `gpt-4o-mini`).
- **Context**: current workout + activeExerciseName + currentSetNumber + loggedSets + serverContext (active injuries, recent completed workouts, last 3 matching exercise histories when available).
- **Scope**: form cues, load/rep adjustment, pain caution, immediate substitutions. Redirects nutrition/lifestyle to Home Trainer.
- **Response**: `{answer, quick_cues, adjustment, safety_note}`.
- **Persistence**: none — display-only.
- **Nuance**: this endpoint can accept an attached image, but it still uses `MODEL_CHAT` today rather than `MODEL_IMAGE`.

## 3. Check-in Coach (daily/weekly)

- **Trigger**: `CoachCheckinModal` submit.
- **Endpoint**: `POST /coach/checkin` → `routers/coach.py::post_checkin`.
- **Model**: gpt-4o-mini via `services/coach/checkin_ai.py`.
- **Context** (richest): profile + plan targets + 4-7 days metrics + 7/14/28-day trends + weight summary + active UserFlag rows + last 1-3 AIDecision rows + user feedback + (weekly) history_digest + prior commitments + trimmed `weekly_review` from `compute_weekly_review`.
- **Response gated** by `decision_rules.gate()` — caps delta size, enforces response-type rules.
- **Response**: `{response_type, message, delta, rationale_key, next_commitments}`.
- **Persistence**: `AIDecision` row + `CoachMemory` rows + optional delta to `UserCoachingState.calorie_adjustment`.
- **Smart check-in**: AI must reference at least one specific number from the weekly review and one rec by short name.

## 4. Quick-Action Intent Router (deterministic, no LLM)

- **File**: `routers/ai/quick_intents.py`.
- **Wired**: runs `match_intent(q)` BEFORE the fast path in `ask_trainer_question`.
- **13 intents**: `time_limited`, `slept_badly`, `too_sore`, `missed_workout`, `travel_mode`, `more_cardio`, `less_cardio`, `deload`, `more_core`, `hard_tomorrow`, `losing_too_fast`, `strength_dropping`, `hungrier`.
- **Output**: matches `TrainerQuestionResponse` with a structured `action` dict the client can apply without another AI call.
- Falls through to LLM path on any miss or handler exception.

## AI Apply Path (architectural rule)

**Rule**: AI/weekly-review can only do what the user can do via existing UI. Recommendations mutate settings that the planner reacts to on next regen.

- **Endpoint**: `POST /coach/apply-action` body `{action, rec_key?}`.
- **Implementation**: `services/coach/apply_action.py::apply_action`.

**State-mutating actions:**
- `change_days_per_week` → `UserPreferences.days_per_week` (capped ±1 per apply)
- `raise_calories` / `lower_calories` → `UserCoachingState.calorie_adjustment` (capped ±250 kcal per apply)
- `hold_calorie_adjustment` → CoachMemory record
- `swap_to_recovery` → tomorrow's `UserDayState.skipped_focus = "recovery"`
- `noop` → ack only

**Descriptive-only (CoachMemory record, no state mutation):** `reduce_muscle_volume`, `add_muscle_volume`, `hold_muscle_volume`, `add_cardio_session`, `add_zone2_session`, `reduce_cardio`, `schedule_deload`, `set_core_frequency`, `shorten_workout`, `reduce_intensity`, `carb_bump_today`, `raise_protein_target`, `raise_fiber_target`, `rebalance_week`, `strength_preservation`, `swap_to_recovery_or_reduce`.

**Wired by**: `WeeklyCoachingCard` (Progress → Health), `CoachCheckinModal` (inline pills), trainer chat (Apply button on assistant messages).

## Known Context Gaps (Home Trainer)

1. Not gated by `decision_rules.gate()` — plan/macro deltas rely on prompt constraints + client approval instead of the check-in safety gate.
2. No `AIDecision` row written for Home Trainer plan updates — check-in decisions are persisted, chat decisions are not.

**Other:**
3. Meal routine protection (`isRoutine=true`) is prompt-enforced, but not represented as a dedicated server-side routine-protection block.

## Recommended AI Improvements

- Apply `decision_rules.gate()` to Home Trainer responses.
- Persist Home Trainer decisions as `AIDecision` rows when `updated_*` fields are returned.
- Move long system prompts out of f-strings into `backend/app/prompts/*.md` files loaded at startup.
- Build 10-20 prompt eval harness for regression testing on prompt edits.
