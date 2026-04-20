from __future__ import annotations

import asyncio
import json
import logging

import openai

logger = logging.getLogger(__name__)
from openai import OpenAI
from fastapi import HTTPException, Depends

from app.auth import get_current_user
from app.models import User

from .router import router
from .models import TrainerQuestionRequest, WorkoutCoachQuestionRequest
from .utils import (
    get_openai_api_key, model_chat, model_chat_fallback,
    _is_gpt5, _build_chat_kwargs, _chat_create, _looks_truncated, _extract_json,
    _log_openai_error,
    SCHEMA_TRAINER_QUESTION, SCHEMA_WORKOUT_QUESTION,
)


@router.get("/smoke-test")
async def smoke_test(model: str = "gpt-5", current_user: User = Depends(get_current_user)):
    """
    Diagnostic endpoint — tests bare chat completions with no structured output.
    GET /ai/smoke-test?model=gpt-5
    Returns {"ok": true, "reply": "..."} or {"ok": false, "error": "..."}
    No auth required so it can be hit with curl quickly.
    """
    api_key = get_openai_api_key()
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY not configured"}
    client = OpenAI(api_key=api_key)
    print(f"[smoke-test] model={model}")
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
        print(f"[smoke-test] OK — reply: {reply!r}")
        return {"ok": True, "model": model, "reply": reply}
    except openai.APIStatusError as e:
        body = getattr(e, 'body', None)
        msg = str(e)
        print(f"[smoke-test] FAIL {e.status_code} — body={body}  str={msg}")
        return {"ok": False, "model": model, "http_status": e.status_code, "error": msg, "body": body}
    except Exception as e:
        print(f"[smoke-test] FAIL {type(e).__name__}: {e}")
        return {"ok": False, "model": model, "error": f"{type(e).__name__}: {e}"}


@router.post("/trainer-question")
def ask_trainer_question(
    body: TrainerQuestionRequest,
    current_user: User = Depends(get_current_user),
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
            fast_kwargs = _build_chat_kwargs(model_intent(), fast_messages, json_schema=None, max_tokens=800, timeout_secs=15)
            fast_resp = _chat_create(client, **fast_kwargs)
            fast_raw = fast_resp.choices[0].message.content
            if fast_raw:
                fast_result = _extract_json(fast_raw)
                if fast_result.get("answer"):
                    logger.info(f"[trainer-question] FAST PATH success: {len(fast_result['answer'])} chars")
                    return fast_result
        except Exception as e:
            logger.warning(f"[trainer-question] FAST PATH failed, falling through to full path: {e}")
        # Fall through to full path if fast path fails

    # Unified coach — send both workout and nutrition context regardless of mode
    profile_slim = body.profile or {}
    foods_available = (profile_slim.get("foodsAvailable") or []) if isinstance(profile_slim, dict) else []
    if isinstance(profile_slim, dict):
        for drop_key in ("customFoods", "savedMeals", "foodsAvailable", "supplementsAvailable"):
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
            print(f"[trainer-question] nutrition context enrichment failed: {e}")

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
        print(f"[trainer-question] topic={topic} — trimming context")
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
    print(f"[trainer-question] context_str length: {len(context_str)} chars")

    trimmed_convo = (body.conversation or [])[-6:]

    # ── What the AI can and cannot do ────────────────────────────────────────
    _capability_instructions = (
        "\n\nWHAT YOU CAN DO:\n"
        "• Modify the plan directly (swap exercises, change days, adjust meals/macros) — "
        "set needs_plan_update=true and return the full updated plan.\n"
        "• If the user asks to change training days (e.g. 'make it 6 days'), return an updated plan "
        "with the new number of days. The app will detect the change and update their settings automatically.\n"
        "• If they ask to change equipment focus, adjust exercises accordingly in the updated plan.\n"
        "• Change the user's primary fitness GOAL. If they say things like 'switch me to fat loss', "
        "'I want to build muscle instead', 'change my goal to strength', set the `updated_goal` field "
        "to the new goal id (see allowed values in the schema). The app will confirm with the user and "
        "regenerate plans accordingly. Also set needs_plan_update=true and return a plan that matches "
        "the new goal so the change takes effect immediately after approval.\n"
        "• Log workouts, track injuries.\n"
        "\n"
        "WHAT YOU CANNOT DO (redirect the user):\n"
        "• Body stats (weight, height, age) → 'You can update that from the ☰ menu → Account.'\n"
        "• Food preferences or dietary restrictions → 'Head to ☰ menu → Edit Meal Plan to update those.'\n"
        "• Supplements → 'You can manage those from ☰ menu → Edit Meal Plan → Supplements tab.'\n"
        "• Meal routines → 'You can edit those from ☰ menu → Edit Meal Plan → Meal Routines.'\n"
        "• Theme/appearance → 'You can change that from ☰ menu → Themes.'\n"
        "• Priority region / training emphasis → 'Head to Goals tab to change your priority region (Balanced / Lower Body / Upper Body).'\n"
        "For anything not listed above, give your best advice and suggest the appropriate menu path if needed.\n"
        "\n"
        "IMPORTANT — TEMPORARY vs PERMANENT CHANGES:\n"
        "When you modify the workout plan in chat, tell the user: 'I've adjusted this week's plan. "
        "This change applies to the current week only — your next generated plan will follow your "
        "saved settings. For a permanent change, update your preferences in the Goals or Workout Settings tab.'\n"
        "This keeps the deterministic planner as the source of truth for future weeks.\n"
    )

    # Unified coach — can update both workout and nutrition plans
    plan_schema = (
        '  "updated_workout_plan": <full workout plan object or null>,\n'
        '  "updated_nutrition_plan": <full nutrition plan object or null>\n'
    )
    system_prompt = (
        "You are an expert fitness coach, strength trainer, and registered dietitian — a single unified coach. "
        "You handle BOTH workout programming AND nutrition advice in the same conversation. "
        "Reference specific exercises, foods, macros, and plan details from the user's actual data. "
        "\n\n"
        "ABSOLUTE RULE — DO WHAT THE USER ASKS:\n"
        "When the user explicitly asks for a specific change, YOU MUST DO IT.\n"
        "- If they ask to change a DAY'S FOCUS (e.g. 'make tomorrow legs', 'swap day 3 to push'), "
        "tell them: 'You can do this directly! Expand the day on your workout tab and tap "
        "\"Switch this day to\" to pick a new focus. This generates proper exercises instantly.' "
        "Do NOT attempt to rebuild the entire plan for a single day swap — the app handles this better.\n"
        "- If they ask to SWAP A SPECIFIC EXERCISE (e.g. 'replace bench press with dumbbell press'), "
        "DO IT by returning the updated plan with the exercise swapped.\n"
        "- Do NOT override their request with recovery opinions.\n\n"
        "CRITICAL — RESPECT THE USER'S SETTINGS:\n"
        "The user's profile contains `preferredSplit` and `priorityRegion`. When modifying the workout plan:\n"
        "- If they chose a split (e.g. PPL, Upper/Lower), keep that split structure. Do NOT switch to a different split.\n"
        "- If they set a priority region (lower_body, upper_body), maintain emphasis on that region.\n"
        "- Keep the same number of training days (`daysPerWeek`) unless they explicitly ask to change it.\n"
        "- Only use exercises compatible with their `equipment` list.\n"
        "- Respect their `experienceLevel` for exercise complexity and volume.\n"
        "- You can swap exercises, reorder days, change focus within a day, or adjust volume — but stay within the user's chosen framework.\n"
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
        "WORKOUT HISTORY — RESPECT COMPLETED SESSIONS:\n"
        "The `progress.workoutHistory` and `progress.recentDays` fields show what the user ACTUALLY did recently.\n"
        "- Entries with `completed: true` are real workouts the user finished — even if `exercises` is empty (manually logged).\n"
        "- A manually logged 'Upper' workout with no exercise details STILL counts. Do NOT schedule Upper again the next day.\n"
        "- When modifying the plan, check `recentDays` first. If the user already did 'Push' today, tomorrow should be 'Pull' or 'Legs' — not 'Push' again.\n"
        "- NEVER mark a day as 'done' or override a day the user already completed. Completed days are immutable.\n"
        "\n"
        "WORKOUT CHANGES: If the user asks to modify workouts, swap exercises, change days, or report injuries, "
        "set needs_plan_update=true and return the COMPLETE updated_workout_plan. "
        "Use structure: { name, totalDays, days: [{ day, focus, stimulus, exercises: [{ name, sets, reps, restSeconds, equipment }] }] }. "
        "NUTRITION CHANGES: If the user asks to modify meals, swap foods, or adjust nutrition, "
        "set needs_plan_update=true and return the COMPLETE updated_nutrition_plan. "
        "Preserve isRoutine=true meals exactly as-is. "
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
        "Do NOT ask the user to type 'yes' — the app renders an 'Add & Update Plan' confirm button "
        "when updated_injuries is present, and the user will tap that button to confirm. Your answer "
        "text should explain the assessment, not ask for text confirmation.\n"
        "4. Do NOT modify the workout plan yourself. Do NOT set needs_plan_update=true for injuries — "
        "the app regenerates the plan automatically after the user taps the confirm button.\n"
        "5. For each injury, include: severity (mild/moderate/severe), affected muscleGroups from "
        "[chest,back,shoulders,biceps,triceps,quads,hamstrings,glutes,calves,core], and "
        "estimatedRecoveryDays (conservative: mild 5-10, moderate 14-28, severe 42-90+).\n"
        "WORKOUT LOGGING: If the user says they completed a workout, set logged_workouts with session data. "
        "Return JSON only."
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
        '  "needs_plan_update": true|false,\n'
        '  "safety_note": "string or empty string",\n'
        '  "updated_goal": "fat_loss|muscle_gain|body_recomp|strength|endurance|athletic_performance|toning|maintain" or null,\n'
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
        '`"updated_macros": {"protein": 130}`. The app saves these as custom macro preferences '
        "and triggers a nutrition regen. Do NOT rebuild the full meal plan for macro-only changes — "
        "the app handles that automatically. You can still set needs_plan_update=true if you ALSO "
        "want to change specific meals.\n"
        "IMPORTANT: If needs_plan_update is true, you MUST include the complete updated plan object "
        "(not just the changed parts - the full structure). Preserve all unchanged days/meals exactly.\n"
        "PLAN SETTING CHANGES: If the user asks to change training days, workout duration, or equipment, "
        "set needs_plan_update=true and return the FULL updated plan reflecting the change. "
        "For example, if they say 'make it 6 days', return a complete 6-day plan. "
        "Do NOT just say you've made the change — you must actually return the updated plan.\n"
        "CRITICAL PROMISE RULE: If your `answer` describes ANY change to the user's plan — "
        "'I'll swap', 'I'll update', 'I'll move', 'I'll change tomorrow to X', 'making it push', "
        "'swapped legs for push', 'moved your rest day', 'let's make it chest focus' — you MUST set "
        "needs_plan_update=true AND return the complete updated plan object. "
        "If you cannot produce a complete plan, DO NOT describe the change in your answer. "
        "Never promise a change you aren't returning as structured data — that leaves the user with "
        "a useless 'Apply' button. Either describe + return, or acknowledge that you can't make the "
        "change right now without promising.\n"
        + (
            "WORKOUT PLAN FORMAT: updated_workout_plan must use this exact structure: "
            '{"name": "...", "totalDays": N, "days": [{"day": "Day 1", "focus": "...", "stimulus": "strength|hypertrophy|volume|conditioning|mixed", "exercises": [{"name": "...", "sets": N, "reps": "...", "restSeconds": N, "equipment": "..."}]}]}. '
            "CRITICAL: Every day MUST have at least 3 exercises. NEVER return a day with an empty exercises array. "
            "STIMULUS FIELD: Every day MUST include a `stimulus` field. Use 'strength' for heavy/low-rep days (3-5 reps), "
            "'hypertrophy' for moderate rep days (6-10 reps), 'volume' for high-rep days (10-15 reps), "
            "'conditioning' for cardio/circuit days, 'mixed' for combination days. "
            "Copy from the original plan when the day's intent hasn't changed."
            if not is_nutritionist else
            "NUTRITION PLAN FORMAT: updated_nutrition_plan must use this exact structure: "
            '{"targets": {"calories": N, "protein": N, "carbs": N, "fat": N}, '
            '"breakfast": {"meal": "...", "items": [{"name": "plain food name", "quantity": N, "unit": "g|oz|lb|ml|fl_oz|cup|tbsp|tsp|piece|slice|scoop|serving", "calories": N, "protein": N, "carbs": N, "fat": N}], "calories": N, "protein": N, "carbs": N, "fat": N, "estimated_alignment": "...", "isRoutine": false}, '
            '"lunch": {...same structure...}, "dinner": {...same structure...}, "snack": {...same structure or omit if no snack...}}. '
            "CRITICAL ITEM RULES: Each items[] entry must have `name` (no quantity in the name), separate `quantity` (number), and `unit` (from the enum). "
            "WRONG: {name: '2 eggs'}.  RIGHT: {name: 'eggs', quantity: 2, unit: 'piece'}. "
            "Per-item macros must sum to meal-level totals. "
            "When the user asks to change a macro target (e.g. 'set protein to 200g'), "
            "update the targets object AND recalculate all meal items to match the new totals."
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

    # Debug: log what we're sending
    print(f"[trainer-question] mode={body.mode} topic={topic} question={repr(q[:120])}")
    print(f"[trainer-question] convo_turns={len(trimmed_convo)} has_image={bool(body.image_base64)} has_userContext={bool(body.userContext)}")
    print(f"[trainer-question] context keys: {list(context_blob.keys())}")

    messages = [
        {"role": "system", "content": system_prompt},
        user_message,
    ]

    client = OpenAI(api_key=api_key)
    try:
        _m_fast = model_chat()           # Phase 1: fast model for answer
        _m_full = model_chat_fallback()   # Phase 2: fallback model for plan generation
        print(f"[trainer-question] phase1_model={_m_fast} phase2_model={_m_full}")

        # Phase 1: answer + optional plan in one call.
        # Don't pass json_schema for gpt-5 — the trainer schema has optional/typeless
        # fields (updated_workout_plan: {}) that gpt-5's json_schema mode rejects.
        # Instead, rely on prompt-enforced JSON which works reliably.
        kwargs = _build_chat_kwargs(_m_fast, messages, json_schema=None, max_tokens=4000, timeout_secs=60)
        response = _chat_create(client, **kwargs)
        choice = response.choices[0]
        raw = choice.message.content

        # Debug: dump full response details
        print(f"[trainer-question] phase-1 response: finish_reason={getattr(choice, 'finish_reason', '?')} content_is_none={raw is None} content_len={len(raw) if raw else 0}")
        print(f"[trainer-question] phase-1 message attrs: {[a for a in dir(choice.message) if not a.startswith('_')]}")
        if hasattr(choice.message, 'refusal') and choice.message.refusal:
            print(f"[trainer-question] phase-1 REFUSAL: {choice.message.refusal}")
        if hasattr(choice.message, 'tool_calls') and choice.message.tool_calls:
            print(f"[trainer-question] phase-1 TOOL_CALLS: {choice.message.tool_calls}")

        # Handle None/empty content — can happen with gpt-5 + json_object format
        if not raw:
            refusal = getattr(choice.message, 'refusal', None)
            finish = getattr(choice, 'finish_reason', 'unknown')
            print(f"[trainer-question] phase-1 returned empty! finish_reason={finish} refusal={refusal}")

            # Retry 1: same model, NO response_format (prompt-enforced JSON)
            print(f"[trainer-question] retry-1: {_m_fast} without response_format")
            kwargs_r1 = dict(model=_m_fast, messages=messages, timeout=55, max_tokens=2500, temperature=1)
            if _is_gpt5(_m_fast):
                kwargs_r1["max_completion_tokens"] = kwargs_r1.pop("max_tokens")
            response = client.chat.completions.create(**kwargs_r1)
            raw = response.choices[0].message.content
            print(f"[trainer-question] retry-1 result: len={len(raw) if raw else 0} finish={getattr(response.choices[0], 'finish_reason', '?')}")

        if not raw:
            # Retry 2: fall back to gpt-4o-mini which reliably supports json_object
            _m_fallback = "gpt-4o-mini"
            print(f"[trainer-question] retry-2: falling back to {_m_fallback}")
            kwargs_r2 = _build_chat_kwargs(_m_fallback, messages, json_schema=None, max_tokens=2500, timeout_secs=55)
            response = _chat_create(client, **kwargs_r2)
            raw = response.choices[0].message.content
            print(f"[trainer-question] retry-2 result: len={len(raw) if raw else 0} finish={getattr(response.choices[0], 'finish_reason', '?')}")

        # Still empty after retries — give up gracefully
        if not raw:
            print(f"[trainer-question] still None after retry — returning fallback")
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
            print(f"[trainer-question] phase-1 truncated — retrying at 5000 tokens")
            kwargs1b = _build_chat_kwargs(_m_fast, messages, json_schema=None, max_tokens=5000, timeout_secs=65)
            response = _chat_create(client, **kwargs1b)
            raw = response.choices[0].message.content or raw

        result = _extract_json(raw)
        logger.info(f"[trainer-question] phase-1: needs_plan_update={result.get('needs_plan_update')} has_workout={bool(result.get('updated_workout_plan'))} has_nutrition={bool(result.get('updated_nutrition_plan'))} injuries={result.get('updated_injuries')} logged_workouts={len(result.get('logged_workouts') or [])}")

        # ── Injury guard: NEVER modify the plan when reporting injuries ──
        # The AI sometimes ignores the system prompt and returns both
        # updated_injuries AND needs_plan_update. The deterministic planner
        # handles injury-aware plan changes — not the AI.
        if result.get("updated_injuries") and isinstance(result["updated_injuries"], list) and len(result["updated_injuries"]) > 0:
            if result.get("needs_plan_update") or result.get("updated_workout_plan") or result.get("updated_nutrition_plan"):
                logger.info("[trainer-question] injury guard: stripping plan update from injury response — planner handles this")
                result["needs_plan_update"] = False
                result["updated_workout_plan"] = None
                result["updated_nutrition_plan"] = None

        # ── Intent-detection safety net ──────────────────────────────
        # The LLM sometimes describes a plan change in `answer` ("yes,
        # I'll update tomorrow to push") but forgets to set
        # needs_plan_update or return the plan object. Without this
        # fallback, the Apply banner never appears and the user sees
        # a confirmation that silently does nothing.
        #
        # We pattern-match on a conservative list of phrases that
        # strongly imply an applied change. Regex is deterministic so
        # this is safe and auditable. False positives here are cheap
        # (they just trigger phase-2 which generates the plan); false
        # negatives are expensive (the user's promised change is lost).
        import re as _re
        answer_text = (result.get("answer") or "").lower()
        # Focus keyword alternation shared across patterns. Must cover
        # lifting splits AND non-lifting modalities — "add a cardio day"
        # is just as much an apply-intent as "make it push". Missing
        # keywords here → intent slips through → Apply banner never
        # shows → user reports "the trainer said yes and did nothing."
        _focus_kw = (
            r"(?:push|pull|legs?|upper|lower|chest|back|full[- ]body|"
            r"cardio|conditioning|zone[ -]?2|intervals?|hiit|tempo|"
            r"sprint|mobility|stretch|recovery|rest|arms?|shoulders?|"
            r"hypertrophy|strength)"
        )
        _intent_patterns = (
            # Future-tense promises: "I'll update / I'll add / I'll swap"
            r"\bi['\u2019]?ll (?:update|swap|change|move|replace|make|set|add|include|schedule|slot|put)\b",
            # Past-tense declarations: "I've added / I updated / I swapped"
            r"\bi['\u2019]?ve (?:updated|swapped|changed|moved|replaced|made|set|added|included|scheduled|slotted|put)\b",
            r"\bi (?:will|have|just) (?:updated|swapped|changed|moved|replaced|made|set|added|included|scheduled)\b",
            # Verb + target: "updated tomorrow", "added a pull day",
            # "swapping tomorrow", "replacing the Wednesday session".
            r"\b(?:updated|swapped|replaced|moved|changed|added|included|scheduled|slotted) (?:a |an |some )?(?:tomorrow|your|the|that|wednesday|thursday|friday|saturday|sunday|monday|tuesday|" + _focus_kw + r")",
            r"\b(?:swapping|changing|moving|replacing|adding|including|scheduling|slotting) (?:a |an |some )?(?:tomorrow|your|the|that|" + _focus_kw + r")",
            # "add a cardio day", "add a pull day", "added an upper day"
            r"\b(?:add(?:ed|ing)?|includ(?:ed|ing)?|schedul(?:ed|ing)?) (?:a |an |another )?" + _focus_kw + r" (?:day|session|workout|block)\b",
            # "tomorrow will be push", "tomorrow is now a cardio day"
            r"\btomorrow(?:['\u2019]s)? (?:will (?:be|have)|is now|becomes|now has) ",
            r"\b(?:making|made) (?:it|tomorrow|that day|wednesday|thursday|friday|saturday|sunday|monday|tuesday) (?:a |an )?" + _focus_kw,
            r"\blet['\u2019]?s (?:make|swap|change|move|add|include|schedule)\b",
            r"\bhere['\u2019]?s your (?:updated|new|revised) (?:plan|week|split|schedule)\b",
            # Soft affirmatives immediately followed by a plan verb:
            # "sure, I can add", "absolutely — adding a cardio day",
            # "done, I've swapped tomorrow".
            r"\b(?:sure|absolutely|done|got it|okay|ok|yes)[,!.\-\u2014 ]+ ?(?:i['\u2019]?(?:ll|ve)|i (?:can|will|have)|let['\u2019]?s|adding|swapping|updating|scheduling)\b",
        )
        intent_detected = any(_re.search(p, answer_text) for p in _intent_patterns)
        if intent_detected and not result.get("needs_plan_update"):
            print(
                f"[trainer-question] intent-detection fired — answer describes a change "
                f"but needs_plan_update was {result.get('needs_plan_update')}. "
                f"Forcing needs_plan_update=true so phase-2 runs."
            )
            result["needs_plan_update"] = True

        # Phase 2: if a plan update was signalled but no plan included, do a dedicated plan-generation call
        needs_workout = not is_nutritionist and result.get("needs_plan_update") and not result.get("updated_workout_plan")
        needs_nutrition = is_nutritionist and result.get("needs_plan_update") and not result.get("updated_nutrition_plan")
        if needs_workout or needs_nutrition:
            plan_type = "workout" if needs_workout else "nutrition"
            print(f"[trainer-question] phase-2: generating {plan_type} plan update at 4500 tokens")
            # Build a focused phase-2 message: carry the answer already given, just ask for the plan
            phase2_answer = result.get("answer", "")
            phase2_injuries = result.get("updated_injuries")
            phase2_injury_note = result.get("injury_clarification_needed", False)
            if needs_workout:
                phase2_user = (
                    f"The coach already answered: {json.dumps(phase2_answer)}\n\n"
                    "Now return ONLY a JSON object with the COMPLETE updated_workout_plan. "
                    "Include ALL days and ALL exercises — even unchanged ones. "
                    "Use this exact structure: "
                    '{"name": "...", "totalDays": N, "days": [{"day": "Day 1", "focus": "...", "exercises": [{"name": "...", "sets": N, "reps": "...", "restSeconds": N, "equipment": "..."}]}]}\n'
                    "Return the full JSON response schema with the plan included:\n"
                    '{"answer": ' + json.dumps(phase2_answer) + ', "action_items": [], "needs_plan_update": true, "safety_note": "", '
                    '"updated_workout_plan": <FULL PLAN HERE>, "updated_nutrition_plan": null, '
                    '"updated_injuries": ' + json.dumps(phase2_injuries) + ', "injury_clarification_needed": ' + json.dumps(phase2_injury_note) + '}'
                )
            else:
                phase2_user = (
                    f"The nutritionist already answered: {json.dumps(phase2_answer)}\n\n"
                    "Now return ONLY a JSON object with the COMPLETE updated_nutrition_plan. "
                    "Include ALL meal keys even if unchanged. Preserve all isRoutine=true meals exactly.\n"
                    "Structure: {\"targets\": {\"calories\": N, \"protein\": N, \"carbs\": N, \"fat\": N}, "
                    "\"breakfast\": {\"meal\": \"...\", \"foods\": [\"...\"], \"calories\": N, \"protein\": N, \"carbs\": N, \"fat\": N, \"isRoutine\": bool}, ...}\n"
                    "Return the full JSON response schema with the plan included:\n"
                    '{"answer": ' + json.dumps(phase2_answer) + ', "action_items": [], "needs_plan_update": true, "safety_note": "", '
                    '"updated_workout_plan": null, "updated_nutrition_plan": <FULL PLAN HERE>, '
                    '"updated_injuries": null, "injury_clarification_needed": false}'
                )
            phase2_messages = [
                {"role": "system", "content": system_prompt},
                user_message,
                {"role": "assistant", "content": raw},
                {"role": "user", "content": phase2_user},
            ]
            kwargs2 = _build_chat_kwargs(_m_full, phase2_messages, json_schema=None, max_tokens=4500, timeout_secs=70)
            response2 = _chat_create(client, **kwargs2)
            raw2 = response2.choices[0].message.content
            result2 = _extract_json(raw2)
            # Merge: keep phase-1 answer/action_items/safety_note, take plan from phase-2
            if needs_workout and result2.get("updated_workout_plan"):
                result["updated_workout_plan"] = result2["updated_workout_plan"]
                print(f"[trainer-question] phase-2: workout plan keys={list(result2['updated_workout_plan'].keys()) if isinstance(result2['updated_workout_plan'], dict) else 'non-dict'}")
            elif needs_nutrition and result2.get("updated_nutrition_plan"):
                result["updated_nutrition_plan"] = result2["updated_nutrition_plan"]
            # Pick up any injury updates from phase-2 if phase-1 didn't have them
            if not result.get("updated_injuries") and result2.get("updated_injuries"):
                result["updated_injuries"] = result2["updated_injuries"]

        # Validate workout plan — reject if any day has 0 exercises
        wp = result.get("updated_workout_plan")
        if isinstance(wp, dict) and "days" in wp:
            days = wp.get("days", [])
            empty_days = [d.get("day", f"Day {i+1}") for i, d in enumerate(days) if not d.get("exercises")]
            if empty_days:
                print(f"[trainer-question] REJECTING plan: days with 0 exercises: {empty_days}")
                result["updated_workout_plan"] = None
                result["needs_plan_update"] = False
                result["answer"] = (result.get("answer", "") +
                    "\n\n(I tried to update the plan but some days came back empty. "
                    "Could you ask again with more detail about what you'd like changed?)")

        print(f"[trainer-question] final: needs_plan_update={result.get('needs_plan_update')} has_workout={bool(result.get('updated_workout_plan'))} has_nutrition={bool(result.get('updated_nutrition_plan'))} injuries={result.get('updated_injuries')}")
        print(f"[trainer-question] answer preview: {repr(result.get('answer', '')[:200])}")
        return result
    except json.JSONDecodeError as e:
        print(f"[trainer-question] JSON decode error: {e}")
        print(f"[trainer-question] raw content: {repr(raw[:500]) if raw else 'None'}")
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
        print(f"[trainer-question] Exception: {e}")
        raise HTTPException(status_code=502, detail=f"Trainer question failed: {str(e)}")



@router.post("/workout-question")
def ask_workout_question(
    body: WorkoutCoachQuestionRequest,
    current_user: User = Depends(get_current_user),
):
    """Workout-session scoped coach Q&A focused on form, pain flags, and execution cues."""
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

    _wq_messages = [
        {
            "role": "system",
            "content": (
                "You are an in-workout coach. Scope is limited to form cues, muscle targeting cues, "
                "load/rep adjustment, pain/injury caution, and immediate substitutions. "
                "If the user asks unrelated nutrition/lifestyle topics, reply briefly and suggest "
                "using Ask Trainer from Home for broader planning. Return JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Workout question:\n{q}\n\n"
                f"Context JSON:\n{json.dumps(context_blob, ensure_ascii=True)}\n\n"
                'Return this JSON schema exactly: '
                '{"answer": string, "quick_cues": [string], "adjustment": string, "safety_note": string}'
            ),
        },
    ]
    client = OpenAI(api_key=api_key)
    try:
        kwargs = _build_chat_kwargs(model_chat(), _wq_messages, json_schema=SCHEMA_WORKOUT_QUESTION, max_tokens=300, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Workout question failed: {str(e)}")


