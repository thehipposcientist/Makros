# AI Coach System — Architecture

Last synced from app state: 2026-05-06

## Overview

Three coaches + one deterministic intent router. No AI in workout plan generation.

## Model Routing

- `MODEL_CHAT` defaults to `gpt-4o-mini` for trainer chat, in-workout coach, and most structured text flows.
- `MODEL_IMAGE` defaults to `gpt-5.4-mini` for dedicated image-analysis routes in `routers/ai/scanning.py` and gear identification.
- This means the 2026-04-29 image-model cost increase is scoped to scan/photo-analysis features, not the main coach-chat surfaces.
- Tagged OpenAI calls use `routers/ai/utils.py::_build_chat_kwargs` + `_chat_create` for GPT-5 parameter normalization, per-user budget checks, and `ai_usage_events` telemetry.

## 1. Home Trainer (unified workout + nutrition)

- **Trigger**: chat input on HomeScreen.
- **Endpoint**: `POST /ai/trainer-question` → `routers/ai/chat.py::ask_trainer_question`.
- **Model**: `MODEL_CHAT` (env var, default gpt-4o-mini).
- **Single-phase**: deterministic quick-intent classification OR full LLM. Chat never generates replacement workout or nutrition plans.
- **Context**: slimProfile + full workoutPlan + nutritionPlan + scheduleMapping + progress (sessionsLast30d, recentDays, last-6 workoutHistory) + foodsAvailable + injuries + last-6 chat turns + optional photo + userContext (last 10 activity-log entries).
- **Response shape**: `{answer, action_items, needs_plan_update, safety_note, updated_goal?, updated_macros?, updated_workout_plan=null, updated_nutrition_plan=null, updated_injuries?, logged_workouts?, injury_clarification_needed?}`.
- **Persistence**: no active PlanWeek mutation. Any legacy `updated_workout_plan` / `updated_nutrition_plan` payload is stripped server-side and client-side. Goal/macro proposals are server-sanitized, persisted as unaccepted `AIDecision(checkin_type="trainer_chat")` rows for audit/cooldown context, then held in `PendingPlanUpdate` until user taps Apply. Injury proposals are held for explicit confirmation; once confirmed they update the user's injury profile for future generated weeks and the current week must be changed through deterministic Change Focus / Swap / Skip controls.

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
- **Privacy**: direct account identifiers are stripped from the structured OpenAI payload before the call; `user_id` is retained only locally for telemetry.
- **Response gated** by `decision_rules.gate()` — caps delta size, enforces response-type rules.
- **Response**: `{response_type, message, delta, rationale_key, next_commitments}`.
- **Persistence**: `AIDecision` row + `CoachMemory` rows. LLM deltas are stored as recommendations for display; they are not auto-applied. User-confirmed mutations route through `POST /coach/apply-action` or deterministic check-in logic.
- **Smart check-in**: AI must reference at least one specific number from the weekly review and one rec by short name.

## 4. Quick-Action Intent Router (deterministic, no LLM)

- **File**: `routers/ai/quick_intents.py`.
- **Wired**: runs `match_intent(q)` BEFORE the fast path in `ask_trainer_question`.
- **13 intents**: `time_limited`, `slept_badly`, `too_sore`, `missed_workout`, `travel_mode`, `more_cardio`, `less_cardio`, `deload`, `more_core`, `hard_tomorrow`, `losing_too_fast`, `strength_dropping`, `hungrier`.
- **Output**: matches `TrainerQuestionResponse` with a structured `action` dict the client can apply without another AI call.
- Falls through to LLM path on any miss or handler exception.

## AI Apply Path (architectural rule)

**Rule**: AI/weekly-review can only do what the user can do via existing UI. Recommendations may mutate durable settings / coach state only after a user-confirmed apply path. The active PlanWeek is fixed for its 7-day window.

- **Endpoint**: `POST /coach/apply-action` body `{action, rec_key?}`.
- **Implementation**: `services/coach/apply_action.py::apply_action`.

**State-mutating actions:**
- `change_days_per_week` → `UserPreferences.days_per_week` (capped ±1 per apply)
- `adjust_calorie_target` → `UserCoachingState.calorie_adjustment` (signed delta, capped ±250 kcal per apply)
- `raise_calories` / `lower_calories` → `UserCoachingState.calorie_adjustment` (capped ±250 kcal per apply)
- `hold_calorie_adjustment` → CoachMemory record
- `swap_to_recovery` → tomorrow's `UserDayState.skipped_focus = "recovery"`
- `shorten_workout` / `set_workout_duration` → `UserPreferences.workout_duration_minutes`
- `schedule_deload` → `UserCoachingState.deload_until_date` + volume adjustment
- `set_core_frequency` → `UserPreferences.core_frequency_per_week`
- `carb_bump_today` → today's `UserDayState.macro_overrides`
- `travel_mode` / `pause_week` → dated `UserDayState.skipped_focus`
- `noop` → ack only

`add_cardio_session` / `add_zone2_session` may increment `days_per_week` by one when the user is below the 7-day cap; otherwise they are descriptive.

**Descriptive-only (CoachMemory record, no state mutation):** `reduce_muscle_volume`, `add_muscle_volume`, `hold_muscle_volume`, `reduce_cardio`, `reduce_intensity`, `raise_protein_target`, `raise_fiber_target`, `rebalance_week`, `strength_preservation`, `swap_to_recovery_or_reduce`, plus any state action missing required parameters.

**Wired by**: `WeeklyCoachingCard` (Progress → Health), `CoachCheckinModal` (inline pills), trainer chat (Apply button on assistant messages).

## Known Context Gaps (Home Trainer)

1. Goal/macro proposals now pass server-side allow-listing/capping and are persisted as unaccepted `AIDecision` rows, but they still rely on explicit client approval rather than the full check-in delta gate.

**Other:**
2. Meal routine protection (`isRoutine=true`) is prompt-enforced, but not represented as a dedicated server-side routine-protection block.

## Recommended AI Improvements

- Move long system prompts out of f-strings into `backend/app/prompts/*.md` files loaded at startup.
- Expand the deterministic prompt-output eval harness from the initial Home Trainer governance cases to 10-20 realistic coach transcripts.
