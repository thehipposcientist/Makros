from __future__ import annotations

import asyncio
import json
import logging
import os
import re

import openai

logger = logging.getLogger(__name__)
from openai import OpenAI
from fastapi import HTTPException, Depends

from app.entitlements import require_pro_feature
from app.models import User

from .router import router
from .models import TrainerQuestionRequest, WorkoutCoachQuestionRequest
from .utils import (
    get_openai_api_key, model_chat,
    _is_gpt5, _build_chat_kwargs, _chat_create, _looks_truncated, _extract_json,
    SCHEMA_WORKOUT_QUESTION,
)

_PROD_ENV_NAMES = {"production", "prod"}


def _ai_debug_logs_enabled() -> bool:
    return os.getenv("AI_DEBUG_LOGS") == "1" and os.getenv("APP_ENV", "").lower() not in _PROD_ENV_NAMES


def _debug_log(message: str, *args) -> None:
    if _ai_debug_logs_enabled():
        logger.debug(message, *args)

_PLAN_CHANGE_FOCUS_KW = (
    r"(?:push|pull|legs?|upper|lower|chest|back|full[- ]body|"
    r"cardio|conditioning|zone[ -]?2|intervals?|hiit|tempo|"
    r"sprint|mobility|stretch|recovery|rest|arms?|shoulders?|"
    r"hypertrophy|strength)"
)

_PLAN_CHANGE_INTENT_PATTERNS = (
    # Future-tense promises: "I'll update / I'll add / I'll swap"
    r"\bi['\u2019]?ll (?:update|swap|change|move|replace|make|set|add|include|schedule|slot|put)\b",
    # Past-tense declarations: "I've added / I updated / I swapped"
    r"\bi['\u2019]?ve (?:updated|swapped|changed|moved|replaced|made|set|added|included|scheduled|slotted|put)\b",
    r"\bi (?:will|have|just) (?:updated|swapped|changed|moved|replaced|made|set|added|included|scheduled)\b",
    # Verb + target: "updated tomorrow", "added a pull day",
    # "swapping tomorrow", "replacing the Wednesday session".
    r"\b(?:updated|swapped|replaced|moved|changed|added|included|scheduled|slotted) (?:a |an |some )?(?:tomorrow|your|the|that|wednesday|thursday|friday|saturday|sunday|monday|tuesday|" + _PLAN_CHANGE_FOCUS_KW + r")",
    r"\b(?:swapping|changing|moving|replacing|adding|including|scheduling|slotting) (?:a |an |some )?(?:tomorrow|your|the|that|" + _PLAN_CHANGE_FOCUS_KW + r")",
    # "add a cardio day", "add a pull day", "added an upper day"
    r"\b(?:add(?:ed|ing)?|includ(?:ed|ing)?|schedul(?:ed|ing)?) (?:a |an |another )?" + _PLAN_CHANGE_FOCUS_KW + r" (?:day|session|workout|block)\b",
    # "tomorrow will be push", "tomorrow is now a cardio day"
    r"\btomorrow(?:['\u2019]s)? (?:will (?:be|have)|is now|becomes|now has) ",
    r"\b(?:making|made) (?:it|tomorrow|that day|wednesday|thursday|friday|saturday|sunday|monday|tuesday) (?:a |an )?" + _PLAN_CHANGE_FOCUS_KW,
    r"\blet['\u2019]?s (?:make|swap|change|move|add|include|schedule)\b",
    r"\bhere['\u2019]?s your (?:updated|new|revised) (?:plan|week|split|schedule)\b",
    # Soft affirmatives immediately followed by a plan verb:
    # "sure, I can add", "absolutely — adding a cardio day",
    # "done, I've swapped tomorrow".
    r"\b(?:sure|absolutely|done|got it|okay|ok|yes)[,!.\-\u2014 ]+ ?(?:i['\u2019]?(?:ll|ve)|i (?:can|will|have)|let['\u2019]?s|adding|swapping|updating|scheduling)\b",
)


def _enforce_trainer_plan_guardrails(result: dict, *, is_nutritionist: bool) -> dict:
    """Keep Home Trainer responses inside the app's real mutation surface."""
    if not isinstance(result, dict):
        return result

    updated_injuries = result.get("updated_injuries")
    has_injury_update = isinstance(updated_injuries, list) and len(updated_injuries) > 0
    if has_injury_update:
        if result.get("needs_plan_update") or result.get("updated_workout_plan") or result.get("updated_nutrition_plan"):
            logger.info("[trainer-question] injury guard: stripping plan update from injury response — planner handles this")
        result["needs_plan_update"] = False
        result["updated_workout_plan"] = None
        result["updated_nutrition_plan"] = None
        return result

    answer_text = (result.get("answer") or "").lower()
    intent_detected = any(re.search(p, answer_text) for p in _PLAN_CHANGE_INTENT_PATTERNS)
    had_legacy_plan = bool(result.get("updated_workout_plan")) or bool(result.get("updated_nutrition_plan"))
    has_setting_update = bool(result.get("updated_goal")) or bool(result.get("updated_macros"))

    if had_legacy_plan:
        logger.info("[trainer-question] plan guardrail: stripped legacy plan payload from trainer response")
        result["updated_workout_plan"] = None
        result["updated_nutrition_plan"] = None
    else:
        result.setdefault("updated_workout_plan", None)
        result.setdefault("updated_nutrition_plan", None)

    if result.get("needs_plan_update"):
        logger.info("[trainer-question] plan guardrail: cleared needs_plan_update; chat cannot request plan rewrites")
        result["needs_plan_update"] = False

    should_redirect_plan_promise = intent_detected or (had_legacy_plan and not has_setting_update)
    if should_redirect_plan_promise:
        if is_nutritionist:
            if has_setting_update:
                result["answer"] = (
                    "I can queue that settings change for confirmation, but I can't directly rewrite your generated meal plan from chat. "
                    "For today's meals, open Meals > Plan, expand the day, then edit the meal or use + Add."
                )
                result["action_items"] = [
                    "Review the proposed setting change and tap Apply if it looks right",
                    "Meals > Plan: expand the day and edit a meal for today",
                    "Meals > Foods: update Your Kitchen, allergies, meals per day, or targets",
                ]
            else:
                result["answer"] = (
                    "I can't directly rewrite your generated meal plan from chat. "
                    "For today's meals, open Meals > Plan, expand the day, then edit the meal or use + Add. "
                    "For durable food, allergy, meal-count, or target changes, use Meals > Foods; supplements live under Meals > Supps."
                )
                result["action_items"] = [
                    "Meals > Plan: expand the day and edit a meal for today",
                    "Meals > Foods: update Your Kitchen, allergies, meals per day, or targets",
                    "Meals > Supps: manage your supplement stack",
                ]
        else:
            if has_setting_update:
                result["answer"] = (
                    "I can queue that settings change for confirmation, but I can't directly rewrite your active 7-day workout plan from chat. "
                    "For this week, open Workout > Plan, expand the day, and use Change Focus or the Swap control on an exercise."
                )
                result["action_items"] = [
                    "Review the proposed setting change and tap Apply if it looks right",
                    "Workout > Plan: expand the day and tap Change Focus",
                    "Workout > Plan: tap Swap on an exercise row for a replacement",
                ]
            else:
                result["answer"] = (
                    "I can't directly rewrite your active 7-day workout plan from chat. "
                    "For this week, open Workout > Plan, expand the day, and use Change Focus or the Swap control "
                    "on an exercise. For future weeks, use Workout > Settings."
                )
                result["action_items"] = [
                    "Workout > Plan: expand the day and tap Change Focus",
                    "Workout > Plan: tap Swap on an exercise row for a replacement",
                    "Workout > Settings: update days/week, split, duration, equipment, or injuries",
                ]
        result["needs_plan_update"] = False

    return result


_TRAINER_ALLOWED_GOALS = {
    "build_muscle", "body_recomp", "lose_fat", "build_strength",
    "improve_cardio", "train_5k", "train_10k", "train_half",
    "train_marathon", "improve_athleticism", "hyrox", "longevity",
    "maintain",
}
_TRAINER_GOAL_ALIASES = {
    "fat_loss": "lose_fat",
    "cut": "lose_fat",
    "get_lean": "lose_fat",
    "toning": "lose_fat",
    "muscle_gain": "build_muscle",
    "strength": "build_strength",
    "endurance": "improve_cardio",
    "cardio": "improve_cardio",
    "athletic_performance": "improve_athleticism",
    "athletic": "improve_athleticism",
    "health": "longevity",
    "general_health": "longevity",
    "flexibility": "longevity",
    "stress_relief": "maintain",
    "maintain_physique": "maintain",
}
_TRAINER_MACRO_BOUNDS = {
    "calories": (1200, 6000, 250),
    "protein": (40, 350, 40),
    "carbs": (25, 800, 100),
    "fat": (20, 250, 40),
}


def _sanitize_trainer_setting_proposals(result: dict, profile: dict | None) -> dict:
    """Validate Home Trainer goal/macro proposals before the client sees them."""
    if not isinstance(result, dict):
        return result
    goal = result.get("updated_goal")
    if goal is not None:
        goal_id = str(goal).strip()
        goal_id = _TRAINER_GOAL_ALIASES.get(goal_id, goal_id)
        result["updated_goal"] = goal_id if goal_id in _TRAINER_ALLOWED_GOALS else None

    macros = result.get("updated_macros")
    if not isinstance(macros, dict):
        result["updated_macros"] = None
        return result

    current = {}
    if isinstance(profile, dict) and isinstance(profile.get("customMacros"), dict):
        current = profile.get("customMacros") or {}

    cleaned: dict[str, int] = {}
    notes: list[str] = []
    for key, raw in macros.items():
        if key not in _TRAINER_MACRO_BOUNDS:
            continue
        lo, hi, max_delta = _TRAINER_MACRO_BOUNDS[key]
        try:
            value = int(round(float(raw)))
        except (TypeError, ValueError):
            continue
        value = max(lo, min(hi, value))
        old = current.get(key)
        if old is not None:
            try:
                old_i = int(round(float(old)))
            except (TypeError, ValueError):
                old_i = value
            delta = value - old_i
            if abs(delta) > max_delta:
                value = old_i + (max_delta if delta > 0 else -max_delta)
                notes.append(f"{key} change capped for safety")
        cleaned[key] = value
    result["updated_macros"] = cleaned or None
    if notes:
        items = result.get("action_items")
        if not isinstance(items, list):
            items = []
        result["action_items"] = [*items, *notes]
    return result


def _persist_trainer_setting_decision(
    db,
    user_id: int,
    result: dict,
    *,
    model: str | None,
) -> None:
    """Persist Home Trainer goal/macro proposals for audit + cooldown context."""
    if not isinstance(result, dict):
        return
    updated_goal = result.get("updated_goal")
    updated_macros = result.get("updated_macros")
    if not updated_goal and not updated_macros:
        return
    try:
        from app.models import AIDecision
        from app.services.coach.decision_rules import gate
        gated = gate(
            {"response_type": "coach_only", "message": result.get("answer") or "Trainer setting proposal."},
            {"metrics_trends": {"w7": {"days_logged": 7}}, "flags": []},
            db,
            user_id,
        )
        db.add(AIDecision(
            user_id=user_id,
            checkin_type="trainer_chat",
            response_type=gated.response_type,
            rationale_key="home_trainer_setting_proposal",
            delta={
                "updated_goal": updated_goal,
                "updated_macros": updated_macros,
            },
            flags_snapshot=[],
            message=(result.get("answer") or "")[:1000],
            accepted=False,
            model=model,
        ))
        db.commit()
    except Exception as exc:
        logger.warning(f"[trainer-question] decision persist failed: {exc}")


@router.get("/smoke-test")
async def smoke_test(model: str = "gpt-4o-mini", current_user: User = Depends(require_pro_feature("AI diagnostics"))):
    """
    Diagnostic endpoint — tests bare chat completions with no structured output.
    GET /ai/smoke-test?model=gpt-4o-mini
    Returns {"ok": true, "reply": "..."} or {"ok": false, "error": "..."}
    """
    api_key = get_openai_api_key()
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY not configured"}
    client = OpenAI(api_key=api_key)
    logger.info("[smoke-test] model=%s", model)
    try:
        response = await asyncio.to_thread(
            lambda: _chat_create(client,
                model=model,
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "Say hello in exactly 5 words."},
                ],
                timeout=30,
            )
        )
        reply = response.choices[0].message.content
        _debug_log("[smoke-test] OK reply=%r", reply)
        return {"ok": True, "model": model, "reply": reply}
    except openai.APIStatusError as e:
        body = getattr(e, 'body', None)
        msg = str(e)
        _debug_log("[smoke-test] FAIL status=%s body=%r str=%r", e.status_code, body, msg)
        return {"ok": False, "model": model, "http_status": e.status_code, "error": msg, "body": body}
    except Exception as e:
        logger.warning("[smoke-test] failed error_type=%s", type(e).__name__)
        return {"ok": False, "model": model, "error": f"{type(e).__name__}: {e}"}


@router.post("/trainer-question")
def ask_trainer_question(
    body: TrainerQuestionRequest,
    current_user: User = Depends(require_pro_feature("Coach chat")),
    db=Depends(__import__('app.database', fromlist=['get_session']).get_session),
):
    """General trainer Q&A with broad plan/profile/progress context."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    q = body.question.strip()
    # Short replies like "Yes" / "No" / "Sure" are valid mid-conversation but
    # spammy as an opener. Require 6+ chars only when this is the first turn.
    has_conversation = bool(body.conversation)
    if not q:
        raise HTTPException(status_code=400, detail="Question is too short")
    if not has_conversation and len(q) < 6:
        raise HTTPException(status_code=400, detail="Question is too short")

    is_nutritionist = body.mode == "nutritionist"

    # ── Structured quick-action intent router (deterministic, no AI) ──────────
    # Catches common asks (only 30 min, too sore, deload, travel, etc) and
    # returns canned responses + structured action dicts. Runs BEFORE
    # the simple-knowledge fast path so "I slept badly" doesn't get
    # treated as a general knowledge question.
    if not body.conversation and not body.image_base64:
        try:
            from app.routers.ai.quick_intents import match_intent, handle_intent
            _intent = match_intent(q)
            if _intent:
                _resp = handle_intent(_intent, q, profile=body.profile)
                if _resp:
                    logger.info(f"[trainer-question] QUICK INTENT: {_intent}")
                    return _resp.to_dict()
        except Exception as _e:
            # Intent router is optional — any failure falls through
            # to the LLM path so the user always gets SOMETHING.
            logger.warning(f"[trainer-question] quick intent router error: {_e}")

    # ── Fast intent classification (deterministic, no AI call) ────────────────
    # Simple questions get a lightweight code path that skips full context loading.
    # This cuts response time from 15-30s to 2-5s for general knowledge questions.
    _q_lower = q.lower()
    _is_simple_knowledge = (
        not body.conversation  # first message, not a follow-up
        and not body.image_base64
        and not any(kw in _q_lower for kw in (
            "swap", "replace", "change", "update", "modify", "switch",
            "my plan", "my workout", "my meal", "my diet", "my macro",
            "calorie", "calories", "kcal", "macro", "macros", "protein",
            "carb", "carbs", "fat",
            "log", "track", "record", "injury", "hurt", "pain",
            "tomorrow", "today", "yesterday", "this week", "next week",
            "day 1", "day 2", "day 3", "day 4", "day 5", "day 6", "day 7",
        ))
        and any(kw in _q_lower for kw in (
            "what is", "what are", "how to", "how do", "how much", "how many",
            "why", "should i", "can i", "is it", "best", "good", "tips",
            "recommend", "suggest", "explain", "difference", "benefit",
            "source", "sources of", "foods high in", "foods with",
            "lower", "reduce", "increase", "improve",
        ))
    )

    if _is_simple_knowledge:
        logger.info(f"[trainer-question] FAST PATH: simple knowledge question detected")
        client = OpenAI(api_key=api_key)
        # Minimal context: just goal + basic profile
        profile_slim_fast = body.profile or {}
        goal = profile_slim_fast.get("goal", "body_recomp") if isinstance(profile_slim_fast, dict) else "body_recomp"
        exp = profile_slim_fast.get("experienceLevel", "intermediate") if isinstance(profile_slim_fast, dict) else "intermediate"
        fast_system = (
            f"You are an expert fitness coach and registered dietitian. "
            f"The user's goal is {goal}, experience level is {exp}. "
            f"Give a concise, practical answer. Use bullet points for actionable advice. "
            f"Keep it under 200 words. Return JSON: "
            f'{{"answer": "...", "action_items": ["..."], "needs_plan_update": false, '
            f'"safety_note": "", "updated_goal": null, "updated_macros": null, '
            f'"updated_workout_plan": null, "updated_nutrition_plan": null, '
            f'"updated_injuries": null, "injury_clarification_needed": false, '
            f'"logged_workouts": null}}'
        )
        fast_messages = [
            {"role": "system", "content": fast_system},
            {"role": "user", "content": q},
        ]
        try:
            from .utils import model_intent
            _fast_model = model_intent()
            fast_kwargs = _build_chat_kwargs(
                _fast_model, fast_messages,
                json_schema=None, max_tokens=800, timeout_secs=15,
                ai_route="/ai/trainer-question:fast",
                ai_user_id=current_user.id,
                ai_budget_bucket="coach_chat",
            )
            fast_resp = _chat_create(client, **fast_kwargs)
            fast_raw = fast_resp.choices[0].message.content
            if fast_raw:
                fast_result = _extract_json(fast_raw)
                if fast_result.get("answer"):
                    fast_result = _enforce_trainer_plan_guardrails(fast_result, is_nutritionist=is_nutritionist)
                    fast_result = _sanitize_trainer_setting_proposals(fast_result, body.profile if isinstance(body.profile, dict) else None)
                    _persist_trainer_setting_decision(db, current_user.id, fast_result, model=_fast_model)
                    logger.info(f"[trainer-question] FAST PATH success: {len(fast_result['answer'])} chars")
                    return fast_result
        except Exception as e:
            logger.warning(f"[trainer-question] FAST PATH failed, falling through to full path: {e}")
        # Fall through to full path if fast path fails

    # Unified coach — send both workout and nutrition context regardless of mode
    profile_slim = body.profile or {}
    foods_available = (profile_slim.get("foodsAvailable") or []) if isinstance(profile_slim, dict) else []
    if isinstance(profile_slim, dict):
        for drop_key in ("customFoods", "savedMeals", "foodsAvailable"):
            profile_slim.pop(drop_key, None)
    context_blob: dict = {"profile": profile_slim, "progress": body.progress}
    # Always include BOTH plans so the unified coach can modify either.
    # The old if/else only sent one — which meant asking to change the
    # workout while a nutrition plan was present dropped the workout context.
    if body.nutritionPlan:
        context_blob["nutritionPlan"] = body.nutritionPlan
        try:
            from app.services.nutrition.context import build_nutrition_context, format_for_prompt
            bw = profile_slim.get("physicalStats", {}).get("weightLbs") if isinstance(profile_slim.get("physicalStats"), dict) else None
            _nctx = build_nutrition_context(
                goal=profile_slim.get("goal"),
                secondary_goal=profile_slim.get("secondaryGoal"),
                experience=profile_slim.get("experienceLevel"),
                bodyweight_lbs=bw,
                dietary_preference=profile_slim.get("dietaryPreference"),
                allergies=profile_slim.get("allergies"),
                foods_available=foods_available,
            )
            context_blob["nutritionContext"] = format_for_prompt(_nctx)
            if foods_available:
                context_blob["foodsAvailable"] = foods_available[:50]
        except Exception as e:
            logger.debug("[trainer-question] nutrition context enrichment failed error_type=%s", type(e).__name__)

    # Always include workout plan when provided
    wp = body.workoutPlan
    if isinstance(wp, dict) and "days" in wp:
        full_days = []
        for d in wp.get("days", []):
            exs = [{"name": e.get("name"), "sets": e.get("sets"), "reps": e.get("reps"),
                     "restSeconds": e.get("restSeconds", 60), "equipment": e.get("equipment", "")}
                    for e in (d.get("exercises") or [])]
            full_days.append({"day": d.get("day"), "focus": d.get("focus"), "stimulus": d.get("stimulus", ""), "exercises": exs})
        context_blob["workoutPlan"] = {"name": wp.get("name"), "totalDays": wp.get("totalDays"), "days": full_days}
    elif wp:
        context_blob["workoutPlan"] = wp
    # Include schedule mapping so AI knows which plan day = which calendar date
    if body.currentPlanContext and isinstance(body.currentPlanContext, dict):
        mapping = body.currentPlanContext.get("scheduleMapping")
        if mapping:
            context_blob["scheduleMapping"] = mapping
    if body.userContext:
        context_blob["recentActivityLog"] = body.userContext[:800]

    # ── Server-side context enrichment ───────────────────────────────────────
    # Injects readiness / weight_trend / active_flags / coach_memory /
    # nutrition_signals / logged_today / timeline_progress. Defensive —
    # failures per-block silently drop that block.
    try:
        from app.services.coach.trainer_context import enrich as _enrich_trainer
        extra = _enrich_trainer(current_user.id, db)
        if extra:
            context_blob["coachContext"] = extra
    except Exception as e:
        logger.debug(f"[trainer-question] server-context enrichment failed (non-fatal): {e}")

    # ── Auto-detect topic from question keywords for context trimming ────────
    topic = body.topic
    if not topic or topic == 'general':
        _ql = q.lower()
        if any(k in _ql for k in ('swap', 'replace', 'change exercise', 'add exercise', 'remove exercise', 'modify workout', 'my workout')):
            topic = 'change_plan'
        elif any(k in _ql for k in ('meal', 'food', 'eat', 'breakfast', 'lunch', 'dinner', 'snack', 'sugar', 'carb', 'protein target', 'calorie')):
            topic = 'change_meals'
        elif any(k in _ql for k in ('hurt', 'pain', 'injury', 'sore', 'strain', 'ache', 'sharp')):
            topic = 'report_injury'
        elif any(k in _ql for k in ('goal', 'switch to', 'change to', 'fat loss', 'muscle gain', 'strength', 'recomp')):
            topic = 'change_goal'
        elif any(k in _ql for k in ('logged', 'did a workout', 'completed', 'i did', 'just finished')):
            topic = 'log_activity'
    if topic:
        logger.info("[trainer-question] topic=%s trimming_context=true", topic)
        if is_nutritionist:
            if topic == "change_meals":
                # Keep nutritionPlan + profile, drop progress/activity
                context_blob.pop("progress", None)
                context_blob.pop("recentActivityLog", None)
            elif topic == "log_food":
                # Only need today's macro targets
                np_ = context_blob.get("nutritionPlan")
                if isinstance(np_, dict):
                    context_blob["nutritionPlan"] = {"targets": np_.get("targets", {})}
                context_blob.pop("progress", None)
                context_blob.pop("recentActivityLog", None)
            elif topic == "general":
                # Slim profile only — drop plans and progress
                context_blob.pop("nutritionPlan", None)
                context_blob.pop("progress", None)
                context_blob.pop("recentActivityLog", None)
        else:
            if topic == "change_plan":
                # Keep workoutPlan + scheduleMapping + recent progress
                context_blob.pop("recentActivityLog", None)
            elif topic == "log_activity":
                # Only need recent progress data
                context_blob.pop("workoutPlan", None)
                context_blob.pop("scheduleMapping", None)
            elif topic == "report_injury":
                # Keep injury info + exercise names only (no full plan details)
                wp = context_blob.get("workoutPlan")
                if isinstance(wp, dict) and "days" in wp:
                    exercise_names = []
                    for d in wp.get("days", []):
                        for ex in d.get("exercises", []):
                            exercise_names.append(ex.get("name", ""))
                    context_blob["workoutPlan"] = {"exerciseNames": exercise_names}
                context_blob.pop("progress", None)
                context_blob.pop("recentActivityLog", None)
            elif topic == "change_goal":
                # Keep profile + progress, drop plans
                context_blob.pop("workoutPlan", None)
                context_blob.pop("scheduleMapping", None)
                context_blob.pop("recentActivityLog", None)
            elif topic == "general":
                # Slim profile only
                context_blob.pop("workoutPlan", None)
                context_blob.pop("progress", None)
                context_blob.pop("scheduleMapping", None)
                context_blob.pop("recentActivityLog", None)

    # Truncate the serialized context if it's still too large (target ~8k chars)
    context_str = json.dumps(context_blob, ensure_ascii=True)
    if len(context_str) > 8000:
        # Drop workout history from progress to save space
        if isinstance(context_blob.get("progress"), dict):
            context_blob["progress"].pop("recentHistory", None)
            context_blob["progress"].pop("workoutHistory", None)
        context_str = json.dumps(context_blob, ensure_ascii=True)
    if len(context_str) > 8000:
        context_str = context_str[:8000] + '...(truncated)}'
    logger.info("[trainer-question] context_length=%s", len(context_str))

    trimmed_convo = (body.conversation or [])[-6:]

    # ── What the AI can and cannot do ────────────────────────────────────────
    _capability_instructions = (
        "\n\nWHAT YOU CAN DO:\n"
        "• Answer questions about workouts, nutrition, recovery, injuries, goals, and the user's current plan.\n"
        "• Recommend safe preference changes for future generated weeks. Recommendations affect settings "
        "or day-state only after the user confirms through the app's deterministic apply path.\n"
        "• For current-week day focus changes (e.g. 'make tomorrow legs', 'swap day 3 to push'), "
        "tell the user to open Workout > Plan, expand that day, and tap Change Focus. "
        "That deterministic UI is the only supported way to rewrite the active PlanWeek.\n"
        "• For specific exercise or meal swaps, explain what to swap and direct the user to the "
        "manual control: Workout > Plan > exercise row > Swap, or Meals > Plan > meal edit. "
        "Do not claim the swap has already happened.\n"
        "• Change the user's primary fitness GOAL. If they say things like 'switch me to fat loss', "
        "'I want to build muscle instead', 'change my goal to strength', set the `updated_goal` field "
        "to the new goal id (see allowed values in the schema). The app will confirm with the user and "
        "future generated weeks will use the new goal. Do not return a replacement plan.\n"
        "• For explicit calorie or macro target changes, set `updated_macros` with only the changed fields. "
        "The app will confirm the setting change; generated meal templates refresh through the normal planner.\n"
        "• Log workouts and track injuries.\n"
        "\n"
        "WHAT YOU CANNOT DO (redirect the user):\n"
        "• Active PlanWeek edits → you cannot directly rewrite the current 7-day plan, change today's "
        "planned workout, or replace generated meal templates from chat. Guide the user to Workout > Plan > "
        "Change Focus / Swap, or Meals > Plan > meal edit instead.\n"
        "• Body stats (weight, height, age) → 'You can update that from You > Body & Stats.'\n"
        "• Food preferences or dietary restrictions → 'Use Meals > Foods to update Your Kitchen, allergies, meals per day, or targets.'\n"
        "• Supplement CHANGES → 'Use Meals > Supps to manage your supplement stack.' "
        "If profile.supplementsAvailable lists what the user already takes, reference it in advice — never recommend what they already take.\n"
        "• Meal routines → 'Open Meals > Plan, expand the day, then tap + Pin on a meal or edit a pinned routine meal.'\n"
        "• Theme/appearance → 'You can change that from You > Settings > Theme.'\n"
        "• Goal or training emphasis → 'Use You > Goal for the goal itself, or Workout > Settings for split and schedule.'\n"
        "For anything not listed above, give your best advice and suggest the appropriate menu path if needed.\n"
        "\n"
        "CRITICAL PLAN GUARDRAIL:\n"
        "Never say 'I changed', 'I swapped', 'I updated', 'I moved', or 'I added' when referring to the "
        "active workout or meal plan. Use language like 'I recommend', 'you can change this by...', "
        "or 'for future generated weeks, update this setting'. Always leave `updated_workout_plan` and "
        "`updated_nutrition_plan` as null. Always set `needs_plan_update=false`; goal or macro setting "
        "proposals belong only in `updated_goal` / `updated_macros` and require user confirmation in the app.\n"
    )

    # Legacy plan fields remain in the API shape for older clients, but
    # Home Trainer is no longer allowed to return replacement plans. The
    # persisted PlanWeek and deterministic planner own that surface.
    plan_schema = (
        '  "updated_workout_plan": null,\n'
        '  "updated_nutrition_plan": null\n'
    )
    system_prompt = (
        "You are an expert fitness coach, strength trainer, and registered dietitian — a single unified coach. "
        "You handle BOTH workout programming AND nutrition advice in the same conversation. "
        "Reference specific exercises, foods, macros, and plan details from the user's actual data. "
        "\n\n"
        "ABSOLUTE RULE — BE HONEST ABOUT CONTROL:\n"
        "When the user explicitly asks for a specific plan change, help them make it through the "
        "supported app control or propose a future preference change. Do not claim you changed the "
        "active plan from chat.\n"
        "- If they ask to change a DAY'S FOCUS (e.g. 'make tomorrow legs', 'swap day 3 to push'), "
        "tell them: 'You can do this directly: open Workout > Plan, expand that day, and tap "
        "Change Focus to pick a new focus. The deterministic planner generates the replacement day.' "
        "Do NOT attempt to rebuild the entire plan for a single day swap — the app handles this better.\n"
        "- If they ask to SWAP A SPECIFIC EXERCISE (e.g. 'replace bench press with dumbbell press'), "
        "explain the best replacement and direct them to Workout > Plan > exercise row > Swap. Do NOT return "
        "a replacement plan or say the swap is already applied.\n"
        "- Do NOT override their request with recovery opinions unless safety signals make it necessary.\n\n"
        "CRITICAL — RESPECT THE USER'S SETTINGS:\n"
        "The user's profile contains `preferredSplit` and `priorityRegion`. When advising on workout changes:\n"
        "- If they chose a split (e.g. PPL, Upper/Lower), keep that split structure. Do NOT switch to a different split.\n"
        "- If they set a priority region (lower_body, upper_body), maintain emphasis on that region.\n"
        "- Keep the same number of training days (`daysPerWeek`) unless they explicitly ask to change it.\n"
        "- Only use exercises compatible with their `equipment` list.\n"
        "- Respect their `experienceLevel` for exercise complexity and volume.\n"
        "- You can recommend exercise swaps, day focus changes, or volume adjustments — but stay within the user's chosen framework and route the actual change through the app controls.\n"
        "- Respect `workoutDurationMinutes` — keep each day's exercises within the user's time limit. A 45-minute session should have fewer exercises than a 75-minute session.\n"
        "- Use the app's exact naming: 'Push', 'Pull', 'Legs', 'Upper', 'Lower', 'Full Body' — not 'Chest/Shoulders/Triceps Day'.\n"
        "- Stimulus labels must be exactly: 'strength', 'hypertrophy', or 'volume' — lowercase.\n"
        "- Day focus must match the split pattern. PPL days use: Push, Pull, Legs. U/L days use: Upper, Lower.\n"
        "\n"
        "\n"
        "SCHEDULE MAPPING:\n"
        "The `scheduleMapping` array maps plan days to calendar dates. Use it to understand "
        "what 'tomorrow', 'Wednesday', etc. mean in terms of which plan day to modify. "
        "Example: if scheduleMapping says {dayLabel: 'tomorrow', planDay: 'Day 3', focus: 'Legs'}, "
        "and the user says 'make tomorrow push', change Day 3's focus from Legs to Push.\n\n"
        "COACH CONTEXT — SERVER-COMPUTED SIGNALS (when present):\n"
        "The `coachContext` block contains computed signals you couldn't otherwise see. "
        "Use them actively when they're relevant to the user's question:\n"
        "  - readiness: {score, top_fatigued, blocked_focuses}. Low readiness (<50) or specific "
        "blocked_focuses means the user should avoid that type of day. Cite the number.\n"
        "  - weight_trend: {slope_lbs_per_wk, ema, last_5}. If they ask about progress, reference the slope. "
        "Positive slope on fat_loss = falling behind; negative slope on muscle_gain = falling behind.\n"
        "  - active_flags: server-detected issues (low_adherence_7d, excessive_soreness, sleep_deficit, etc). "
        "Address flags that relate to the question.\n"
        "  - coach_memory: {last_decisions, open_commitments}. Reference prior coaching (e.g. 'last time I "
        "suggested X — how did that go?') instead of starting from scratch.\n"
        "  - nutrition_signals: {score, top_gaps, recovery_flags}. If the user asks about nutrition or "
        "recovery, cite the actual score and named gaps. Don't generalize.\n"
        "  - logged_today: actual logged cal/protein for today. If asking about what to eat, subtract this "
        "from targets to get what's LEFT today. Don't recommend 2000 cal if they've already eaten 1800.\n"
        "  - timeline_progress: {weeks_elapsed, pct_weight_delta_achieved}. If pct_timeline_elapsed is "
        "much bigger than pct_weight_delta_achieved, they're behind pace — say so plainly.\n"
        "Never invent values for coachContext fields. If a field is absent, it's unknown — don't guess.\n\n"
        "WORKOUT HISTORY — RESPECT COMPLETED SESSIONS:\n"
        "The `progress.workoutHistory` and `progress.recentDays` fields show what the user ACTUALLY did recently.\n"
        "- Entries with `completed: true` are real workouts the user finished — even if `exercises` is empty (manually logged).\n"
        "- A manually logged 'Upper' workout with no exercise details STILL counts. Do NOT schedule Upper again the next day.\n"
        "- When modifying the plan, check `recentDays` first. If the user already did 'Push' today, tomorrow should be 'Pull' or 'Legs' — not 'Push' again.\n"
        "- NEVER mark a day as 'done' or override a day the user already completed. Completed days are immutable.\n"
        "\n"
        "WORKOUT PLAN CHANGES: If the user asks to modify workouts, swap exercises, change days, "
        "or alter this week's schedule, do NOT set needs_plan_update and do NOT return "
        "updated_workout_plan. Explain the supported manual control or recommend a future preference change.\n"
        "NUTRITION PLAN CHANGES: If the user asks to modify meals, swap foods, or alter generated "
        "meal templates, do NOT set needs_plan_update and do NOT return updated_nutrition_plan. "
        "Give specific guidance and direct them to Meals > Plan meal editing or Meals > Foods settings.\n"
        "MACRO TARGET CHANGES: set `updated_macros` with only the changed fields. "
        "INJURY HANDLING — IMPORTANT:\n"
        "When a user reports pain or injury, follow this exact protocol:\n"
        "1. Ask clarifying questions (where exactly, when it started, what triggers it, severity). "
        "Set injury_clarification_needed=true. Do NOT create the injury yet.\n"
        "2. Once you have enough info, ASSESS the injury and explain:\n"
        "   - What the injury likely is (in simple terms)\n"
        "   - What your assessment is (severity, affected muscles)\n"
        "   - What movements would be avoided (e.g., 'hinge movements like deadlifts')\n"
        "   - Estimated recovery timeline\n"
        "   - What to watch for (warning signs to see a doctor)\n"
        "3. IMMEDIATELY populate updated_injuries with the structured data in the SAME response. "
        "Do NOT ask the user to type 'yes' — the app renders an 'Add Injury' confirm button "
        "when updated_injuries is present, and the user will tap that button to confirm. Your answer "
        "text should explain the assessment, not ask for text confirmation.\n"
        "4. Do NOT modify the workout plan yourself. Do NOT set needs_plan_update=true for injuries — "
        "confirmed injuries affect future generated weeks; this week must be adjusted through Change Focus, Swap, or Skip.\n"
        "5. For each injury, include: severity (mild/moderate/severe), affected muscleGroups from "
        "[chest,back,shoulders,biceps,triceps,quads,hamstrings,glutes,calves,core], and "
        "estimatedRecoveryDays (conservative: mild 5-10, moderate 14-28, severe 42-90+).\n"
        "WORKOUT LOGGING: If the user says they completed a workout, set logged_workouts with session data. "
        "\n\nNUTRITION DEPTH — LONGEVITY / MEAL TIMING / FASTING:\n"
        "When the user asks about longevity, meal timing, intermittent fasting, protein pacing, "
        "eating windows, pre- or post-workout nutrition, micronutrient density, fiber, hydration, "
        "sleep-supporting nutrition, or supplement timing, answer concretely with practical guidance:\n"
        "- Explain the current evidence base (what's well-supported vs. experimental).\n"
        "- Give a concrete protocol they could try (e.g. 16:8 eating window from 11a-7p, 30-40g "
        "protein per meal, front-load carbs around training, 25-35g fiber/day, 0.5-1g/lb protein).\n"
        "- Tie the advice to THEIR goal, training volume, and weight — don't give generic tips.\n"
        "- Flag honest tradeoffs (e.g. fasting may help with adherence for some but can hurt "
        "recovery/strength performance when training intensity is high).\n"
        "- If applying to the plan requires a meal schedule change, explain which meal routine or "
        "meal-plan setting to edit. Do not claim you updated generated meals from chat.\n"
        "- Don't medicalize — you're a coach, not a doctor. Recommend professional help for "
        "diagnosable conditions (thyroid, GI disorders, diabetes, etc.)."
        "\n\nReturn JSON only."
        + _capability_instructions
    )

    workout_log_schema = (
        '  "logged_workouts": [{"date": "YYYY-MM-DD", "focus": "...", "durationSeconds": 3600, "exercises": [{"name": "...", "sets": [{"weightLbs": 0, "reps": 0}]}]}] or null,\n'
        if not is_nutritionist else
        '  "logged_workouts": null,\n'
    )
    injury_schema = (
        '  "updated_injuries": [{"id": "uuid", "description": "...", "bodyPart": "...", '
        '"muscleGroups": ["back", "core"], "severity": "mild|moderate|severe", '
        '"estimatedRecoveryDays": 14, "status": "active|recovering|resolved", "notes": "..."}] or null,\n'
        '  "injury_clarification_needed": true|false\n'
        if not is_nutritionist else
        '  "updated_injuries": null,\n'
        '  "injury_clarification_needed": false\n'
    )

    today_date = __import__("datetime").date.today().isoformat()
    user_text = (
        f"Today's date is {today_date}.\n\n"
        f"Recent conversation (most recent last):\n"
        f"{json.dumps(trimmed_convo, ensure_ascii=True)}\n\n"
        f"User question:\n{q}\n\n"
        f"Context:\n{context_str}\n\n"
        "Return ONLY valid JSON matching this schema exactly - no markdown, no extra text:\n"
        '{\n'
        '  "answer": "Detailed, personalised response to the user",\n'
        '  "action_items": ["specific actionable step 1", "..."],\n'
        '  "needs_plan_update": false,\n'
        '  "safety_note": "string or empty string",\n'
        '  "updated_goal": "build_muscle|body_recomp|lose_fat|build_strength|improve_cardio|train_5k|train_10k|train_half|train_marathon|improve_athleticism|hyrox|longevity|maintain" or null,\n'
        '  "updated_macros": {"calories": N, "protein": N, "carbs": N, "fat": N} or null,\n'
        + plan_schema
        + workout_log_schema
        + injury_schema +
        '}\n\n'
        "GOAL UPDATES: Set `updated_goal` ONLY when the user explicitly asks to change their fitness goal "
        "(e.g. 'I want to cut now', 'switch me to strength'). Otherwise leave it null. "
        "Never change the goal silently just because you think it would be better.\n"
        "MACRO ADJUSTMENTS: When the user asks to change calorie or macro targets "
        "(e.g. 'set protein to 130g', 'lower calories to 1800', 'bump carbs up'), "
        "set `updated_macros` with ONLY the changed fields. Example: user says 'make my protein 130g' → "
        '`"updated_macros": {"protein": 130}`. After the user confirms, the app saves these as custom macro preferences. '
        "Do NOT rebuild the full meal plan for macro-only changes - generated meal templates update through the normal planner. "
        "If the user also wants to change specific meals, guide them "
        "to the meal edit controls instead of returning a generated meal plan.\n"
        "PLAN FIELD GUARDRAIL: Always return updated_workout_plan=null and updated_nutrition_plan=null. "
        "Do not generate replacement plans in chat.\n"
        "PLAN SETTING CHANGES: If the user asks to change training days, workout duration, or equipment, "
        "explain that the setting affects future generated weeks and tell them where to update it. "
        "Do NOT say you have made the change unless the response includes a supported structured field "
        "such as updated_goal or updated_macros.\n"
        "CRITICAL PROMISE RULE: If your `answer` describes ANY active plan change — "
        "'I'll swap', 'I'll update', 'I'll move', 'I'll change tomorrow to X', 'making it push', "
        "'swapped legs for push', 'moved your rest day', 'let's make it chest focus' — rewrite the answer "
        "before returning it. You cannot make that promise from chat.\n"
        + (
            "WORKOUT PLAN FORMAT: updated_workout_plan must be null. The active PlanWeek is DB-owned "
            "and can only be changed by deterministic app controls."
            if not is_nutritionist else
            "NUTRITION PLAN FORMAT: updated_nutrition_plan must be null. Generated meal templates "
            "refresh through deterministic nutrition regeneration, not chat-generated replacements."
        )
    )

    # Build user message — use vision format if image is attached
    if body.image_base64:
        user_message = {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{body.mime_type};base64,{body.image_base64}",
                        "detail": "low",
                    },
                },
            ],
        }
    else:
        user_message = {"role": "user", "content": user_text}

    # ── Topic-specific system prompt additions ─────────────────────────────
    # Topic is used for backend context trimming only (not shown to user).
    # The unified coach handles all requests in a single chat.
    _topic_context_hints = {
        "change_plan": "The user's question is about their workout plan.",
        "log_activity": "The user wants to log a completed workout.",
        "report_injury": "The user may be reporting pain or injury.",
        "change_meals": "The user's question is about their meal plan.",
        "log_food": "The user wants to log food they ate.",
        "change_goal": "The user may want to change their fitness goal.",
        "general": "General fitness or nutrition question.",
    }
    if topic and topic in _topic_context_hints:
        system_prompt += f"\n\nCONTEXT HINT: {_topic_context_hints[topic]}"

    logger.info(
        "[trainer-question] request mode=%s topic=%s convo_turns=%s has_image=%s has_user_context=%s",
        body.mode,
        topic,
        len(trimmed_convo),
        bool(body.image_base64),
        bool(body.userContext),
    )
    _debug_log("[trainer-question] context keys=%s", list(context_blob.keys()))

    messages = [
        {"role": "system", "content": system_prompt},
        user_message,
    ]

    client = OpenAI(api_key=api_key)
    try:
        _m_fast = model_chat()           # Phase 1: fast model for answer
        logger.info("[trainer-question] model=%s", _m_fast)

        # Phase 1: answer + optional plan in one call.
        # Don't pass json_schema for gpt-5 — the trainer schema has optional/typeless
        # fields (updated_workout_plan: {}) that gpt-5's json_schema mode rejects.
        # Instead, rely on prompt-enforced JSON which works reliably.
        kwargs = _build_chat_kwargs(
            _m_fast, messages,
            json_schema=None, max_tokens=4000, timeout_secs=60,
            ai_route="/ai/trainer-question",
            ai_user_id=current_user.id,
            ai_budget_bucket="coach_chat",
            ai_image_count=1 if body.image_base64 else 0,
        )
        response = _chat_create(client, **kwargs)
        choice = response.choices[0]
        raw = choice.message.content

        logger.info(
            "[trainer-question] phase-1 response finish_reason=%s content_is_none=%s content_len=%s",
            getattr(choice, 'finish_reason', '?'),
            raw is None,
            len(raw) if raw else 0,
        )
        _debug_log("[trainer-question] phase-1 message attrs=%s", [a for a in dir(choice.message) if not a.startswith('_')])
        if hasattr(choice.message, 'refusal') and choice.message.refusal:
            _debug_log("[trainer-question] phase-1 refusal=%r", choice.message.refusal)
        if hasattr(choice.message, 'tool_calls') and choice.message.tool_calls:
            _debug_log("[trainer-question] phase-1 tool_calls=%r", choice.message.tool_calls)

        # Handle None/empty content — can happen with gpt-5 + json_object format
        if not raw:
            refusal = getattr(choice.message, 'refusal', None)
            finish = getattr(choice, 'finish_reason', 'unknown')
            logger.warning(
                "[trainer-question] phase-1 returned empty finish_reason=%s has_refusal=%s",
                finish,
                bool(refusal),
            )

            # Retry 1: same model, NO response_format (prompt-enforced JSON)
            logger.info("[trainer-question] retry-1 model=%s without_response_format=true", _m_fast)
            kwargs_r1 = _build_chat_kwargs(
                _m_fast, messages,
                json_schema=None, max_tokens=2500, timeout_secs=55,
                ai_route="/ai/trainer-question:retry-empty",
                ai_user_id=current_user.id,
                ai_budget_bucket="coach_chat",
                ai_image_count=1 if body.image_base64 else 0,
            )
            response = _chat_create(client, **kwargs_r1)
            raw = response.choices[0].message.content
            logger.info(
                "[trainer-question] retry-1 result len=%s finish=%s",
                len(raw) if raw else 0,
                getattr(response.choices[0], 'finish_reason', '?'),
            )

        if not raw:
            # Retry 2: fall back to gpt-4o-mini which reliably supports json_object
            _m_fallback = "gpt-4o-mini"
            logger.info("[trainer-question] retry-2 fallback_model=%s", _m_fallback)
            kwargs_r2 = _build_chat_kwargs(_m_fallback, messages, json_schema=None, max_tokens=2500, timeout_secs=55)
            response = _chat_create(client, **kwargs_r2)
            raw = response.choices[0].message.content
            logger.info(
                "[trainer-question] retry-2 result len=%s finish=%s",
                len(raw) if raw else 0,
                getattr(response.choices[0], 'finish_reason', '?'),
            )

        # Still empty after retries — give up gracefully
        if not raw:
            logger.warning("[trainer-question] empty after retries returning fallback")
            return {
                "answer": "I received your message but couldn't generate a response. Please try rephrasing or asking again.",
                "action_items": [],
                "needs_plan_update": False,
                "safety_note": "",
                "updated_goal": None,
                "updated_workout_plan": None,
                "updated_nutrition_plan": None,
                "updated_injuries": None,
                "injury_clarification_needed": False,
            }

        if _looks_truncated(raw):
            logger.info("[trainer-question] phase-1 truncated retrying=true max_tokens=5000")
            kwargs1b = _build_chat_kwargs(
                _m_fast, messages,
                json_schema=None, max_tokens=5000, timeout_secs=65,
                ai_route="/ai/trainer-question:retry",
                ai_user_id=current_user.id,
                ai_budget_bucket="coach_chat",
                ai_image_count=1 if body.image_base64 else 0,
            )
            response = _chat_create(client, **kwargs1b)
            raw = response.choices[0].message.content or raw

        result = _extract_json(raw)
        logger.info(
            "[trainer-question] phase-1 parsed needs_plan_update=%s has_workout=%s has_nutrition=%s injury_count=%s logged_workouts=%s",
            result.get('needs_plan_update'),
            bool(result.get('updated_workout_plan')),
            bool(result.get('updated_nutrition_plan')),
            len(result.get('updated_injuries') or []),
            len(result.get('logged_workouts') or []),
        )

        result = _enforce_trainer_plan_guardrails(result, is_nutritionist=is_nutritionist)
        result = _sanitize_trainer_setting_proposals(result, body.profile if isinstance(body.profile, dict) else None)
        _persist_trainer_setting_decision(db, current_user.id, result, model=_m_fast)

        # Validate workout plan — reject if any day has 0 exercises
        wp = result.get("updated_workout_plan")
        if isinstance(wp, dict) and "days" in wp:
            days = wp.get("days", [])
            empty_days = [d.get("day", f"Day {i+1}") for i, d in enumerate(days) if not d.get("exercises")]
            if empty_days:
                logger.warning("[trainer-question] rejecting empty plan days count=%s", len(empty_days))
                result["updated_workout_plan"] = None
                result["needs_plan_update"] = False
                result["answer"] = (result.get("answer", "") +
                    "\n\n(I tried to update the plan but some days came back empty. "
                    "Could you ask again with more detail about what you'd like changed?)")

        logger.info(
            "[trainer-question] final needs_plan_update=%s has_workout=%s has_nutrition=%s injury_count=%s",
            result.get('needs_plan_update'),
            bool(result.get('updated_workout_plan')),
            bool(result.get('updated_nutrition_plan')),
            len(result.get('updated_injuries') or []),
        )
        return result
    except json.JSONDecodeError as e:
        logger.warning("[trainer-question] JSON decode error error_type=%s", type(e).__name__)
        _debug_log("[trainer-question] raw content=%r", raw[:500] if raw else None)
        # Return a graceful fallback so the chat doesn't break
        return {
            "answer": "I'm sorry, I had trouble processing that response. Could you try rephrasing your question?",
            "action_items": [],
            "needs_plan_update": False,
            "safety_note": "",
            "updated_goal": None,
            "updated_workout_plan": None,
            "updated_nutrition_plan": None,
            "updated_profile": None,
            "updated_injuries": None,
            "injury_clarification_needed": False,
        }
    except Exception as e:
        logger.warning("[trainer-question] failed error_type=%s", type(e).__name__)
        raise HTTPException(status_code=502, detail="Trainer question failed")



def _workout_coach_server_context(
    user_id: int,
    db,
    *,
    active_exercise_name: str | None,
) -> dict:
    """Compact DB context for the in-workout coach.

    This is additive only: if history is sparse or a lookup fails, the
    caller simply sends the live workout payload it already had.
    """
    from sqlmodel import select
    from app.models import (
        ExerciseSet,
        UserPreferences,
        WorkoutCompletion,
        WorkoutExercise,
        WorkoutSession,
    )

    out: dict = {}

    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    injuries = list(getattr(prefs, "injuries", None) or []) if prefs else []
    if injuries:
        out["injuries"] = injuries[:8]

    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .order_by(WorkoutCompletion.workout_date.desc())
        .limit(5)
    ).all()
    if completions:
        out["recentCompletedWorkouts"] = [
            {
                "date": c.workout_date.isoformat(),
                "focus": c.focus_label,
                "feeling": c.feeling,
                "intensity": c.intensity,
                "sorenessAreas": c.soreness_areas or [],
            }
            for c in completions
        ]

    name = (active_exercise_name or "").strip().lower()
    if not name:
        return out

    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id)
        .order_by(WorkoutSession.workout_date.desc())
        .limit(12)
    ).all()
    history: list[dict] = []
    for session in sessions:
        exercises = db.exec(
            select(WorkoutExercise).where(WorkoutExercise.session_id == session.id)
        ).all()
        match = next(
            (
                ex for ex in exercises
                if (ex.name or "").strip().lower() == name
            ),
            None,
        )
        if not match:
            continue
        sets = db.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id == match.id)
            .order_by(ExerciseSet.set_number.asc())
        ).all()
        logged_sets = [
            {
                "setNumber": s.set_number,
                "reps": s.actual_reps,
                "weightLbs": s.actual_weight_lbs,
                "rir": s.actual_rir,
            }
            for s in sets
            if s.actual_reps is not None or s.actual_weight_lbs is not None
        ]
        if not logged_sets:
            continue
        history.append({
            "date": session.workout_date.isoformat(),
            "focus": session.focus,
            "sets": logged_sets[:6],
        })
        if len(history) >= 3:
            break

    if history:
        out["recentExerciseHistory"] = history
    return out


@router.post("/workout-question")
def ask_workout_question(
    body: WorkoutCoachQuestionRequest,
    current_user: User = Depends(require_pro_feature("In-workout coach")),
    db=Depends(__import__('app.database', fromlist=['get_session']).get_session),
):
    """Workout-session scoped coach Q&A focused on form, pain flags, and
    execution cues.

    Optional `image_base64` attaches a photo (e.g., a phone snap of the
    user's knee position mid-set) — the call routes through gpt-4o-mini's
    vision endpoint when present. HEIC photos are re-encoded to JPEG on
    the way in.

    Optional `conversation` carries prior turns of the same coach session
    so follow-up questions ("what about my back?") don't have to restate
    context. We cap to the last 6 turns to keep prompt + cost bounded."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    q = body.question.strip()
    if len(q) < 4:
        raise HTTPException(status_code=400, detail="Question is too short")

    context_blob = {
        "workout": body.workout,
        "activeExerciseName": body.activeExerciseName,
        "currentSetNumber": body.currentSetNumber,
        "loggedSets": body.loggedSets or [],
    }
    try:
        extra_context = _workout_coach_server_context(
            current_user.id,
            db,
            active_exercise_name=body.activeExerciseName,
        )
        if extra_context:
            context_blob["serverContext"] = extra_context
    except Exception as e:
        logger.debug(f"[workout-question] server-context enrichment failed (non-fatal): {e}")

    # Build the latest user-turn content. When an image is present,
    # switch to multipart vision format so gpt-4o-mini can see the
    # attached photo alongside the textual context.
    user_text = (
        f"Workout question:\n{q}\n\n"
        f"Context JSON:\n{json.dumps(context_blob, ensure_ascii=True)}\n\n"
        'Return this JSON schema exactly: '
        '{"answer": string, "quick_cues": [string], "adjustment": string, "safety_note": string}'
    )
    if body.image_base64:
        from .scanning import _fix_image_mime
        fb64, fmime = _fix_image_mime(body.image_base64, body.mime_type or "image/jpeg")
        latest_user = {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{fmime};base64,{fb64}",
                        "detail": "low",
                    },
                },
            ],
        }
    else:
        latest_user = {"role": "user", "content": user_text}

    # Trim conversation to the last 6 turns to keep prompt + cost bounded.
    # Sanitize: only accept role in {"user","assistant"} with string content.
    history: list[dict] = []
    if isinstance(body.conversation, list):
        for turn in body.conversation[-6:]:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role")
            content = turn.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                history.append({"role": role, "content": content.strip()[:2000]})

    _wq_messages = [
        {
            "role": "system",
            "content": (
                "You are an in-workout coach. Scope is limited to form cues, muscle targeting cues, "
                "load/rep adjustment, pain/injury caution, and immediate substitutions. "
                "If the user asks unrelated nutrition/lifestyle topics, reply briefly and suggest "
                "using Ask Trainer from Home for broader planning. "
                "Use serverContext.injuries and serverContext.recentExerciseHistory when relevant; "
                "never recommend loading through pain or ignoring an active injury. "
                "When a photo is attached, comment on what you can actually see — joint angles, "
                "bar path, foot position — and avoid claiming form details the photo doesn't show. "
                "Return JSON only."
            ),
        },
        *history,
        latest_user,
    ]

    client = OpenAI(api_key=api_key)
    # Slightly higher token budget when an image is present so the
    # response can carry the additional cue + safety detail vision
    # input typically warrants. Keep text-only calls tight.
    _max = 500 if body.image_base64 else 300
    try:
        kwargs = _build_chat_kwargs(
            model_chat(), _wq_messages,
            json_schema=SCHEMA_WORKOUT_QUESTION,
            max_tokens=_max, timeout_secs=30,
            ai_route="/ai/workout-question",
            ai_user_id=current_user.id,
            ai_budget_bucket="coach_chat",
            ai_image_count=1 if body.image_base64 else 0,
        )
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Workout question failed: {str(e)}")
