from __future__ import annotations

import asyncio
import json

import openai
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
async def smoke_test(model: str = "gpt-5"):
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
    if len(q) < 6:
        raise HTTPException(status_code=400, detail="Question is too short")

    is_nutritionist = body.mode == "nutritionist"

    # Only send context relevant to this coach's domain — keep payload lean for speed
    profile_slim = body.profile or {}
    # Drop heavy fields from profile context to reduce token count
    if isinstance(profile_slim, dict):
        for drop_key in ("customFoods", "savedMeals", "foodsAvailable", "supplementsAvailable"):
            profile_slim.pop(drop_key, None)
    context_blob: dict = {"profile": profile_slim, "progress": body.progress}
    if is_nutritionist:
        context_blob["nutritionPlan"] = body.nutritionPlan
    else:
        # Send full workout plan so the AI can return a complete updated plan
        # with all fields (equipment, restSeconds, etc.)
        wp = body.workoutPlan
        if isinstance(wp, dict) and "days" in wp:
            # Keep full exercise details but cap to avoid token overflow
            full_days = []
            for d in wp.get("days", []):
                exs = [{"name": e.get("name"), "sets": e.get("sets"), "reps": e.get("reps"),
                         "restSeconds": e.get("restSeconds", 60), "equipment": e.get("equipment", "")}
                        for e in (d.get("exercises") or [])]
                full_days.append({"day": d.get("day"), "focus": d.get("focus"), "exercises": exs})
            context_blob["workoutPlan"] = {"name": wp.get("name"), "totalDays": wp.get("totalDays"), "days": full_days}
        else:
            context_blob["workoutPlan"] = wp
    # Include schedule mapping so AI knows which plan day = which calendar date
    if body.currentPlanContext and isinstance(body.currentPlanContext, dict):
        mapping = body.currentPlanContext.get("scheduleMapping")
        if mapping:
            context_blob["scheduleMapping"] = mapping
    if body.userContext:
        context_blob["recentActivityLog"] = body.userContext[:800]

    # ── Topic-based context trimming ─────────────────────────────────────────
    # When a topic is specified, drop irrelevant keys to reduce token count
    topic = body.topic
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
        "For anything not listed above, give your best advice and suggest the appropriate menu path if needed.\n"
    )

    # Schema differs by mode — AI can only update its own side
    if is_nutritionist:
        plan_schema = (
            '  "updated_workout_plan": null,\n'
            '  "updated_nutrition_plan": <full nutrition plan object matching original structure, or null>\n'
        )
        system_prompt = (
            "You are an expert registered dietitian and sports nutritionist. "
            "Give detailed, personalised nutritional advice referencing specific foods, quantities, and macros from their plan. "
            "Use realistic ingredient amounts (e.g. '150g chicken breast', '1 cup cooked oats'). "
            "If the user asks to modify meals, swap foods, change macro targets, or adjust calories/protein/carbs/fat, "
            "set needs_plan_update=true and return the COMPLETE updated nutrition plan. "
            "WHEN UPDATING MACRO TARGETS: update the 'targets' object with the new values, then adjust ALL meals "
            "so their totals actually hit the new targets. Don't just change targets without changing meals. "
            "Preserve isRoutine=true meals exactly as-is. "
            "updated_workout_plan must always be null. Return JSON only."
            + _capability_instructions +
            "As a nutritionist you CANNOT modify the workout plan — if they ask about exercises or training, "
            "tell them to switch to the Trainer chat for that."
        )
    else:
        plan_schema = (
            '  "updated_workout_plan": <full workout plan object matching original structure, or null>,\n'
            '  "updated_nutrition_plan": null\n'
        )
        system_prompt = (
            "You are an expert strength and conditioning coach. "
            "You have access to the user's full profile, workout plan, progress history, and activity log. "
            "Give detailed, personalised training advice. Always reference specific exercises, sets, "
            "reps, and weights from their actual plan. "
            "Always check the profile's 'injuries' and 'injuryEntries' fields first — if injuries are present, "
            "remove or substitute any exercises that stress those areas. "
            "SCHEDULE MAPPING: The context includes a 'scheduleMapping' array that maps plan days to "
            "calendar dates. When the user says 'tomorrow' or 'today' or a weekday name, use this mapping "
            "to identify which plan day (Day 1, Day 2, etc.) they mean, then modify THAT day. "
            "REBALANCING: When a user changes a day's focus (e.g. 'make tomorrow back day'), you MUST "
            "rebalance the ENTIRE week to account for the change. Consider: "
            "(1) Don't schedule the same muscle group on consecutive days — ensure adequate recovery. "
            "(2) If the changed day duplicates another day's focus, swap or adjust the other day. "
            "(3) If a recovery/rest day was replaced with training, consider adding recovery elsewhere. "
            "(4) Keep the total number of training days the same unless the user asked to change it. "
            "(5) Maintain balanced muscle group coverage across the week. "
            "Think of yourself as reprogramming the whole week, not just editing one slot. "
            "If the user asks for plan changes, exercise swaps, or injury modifications, "
            "set needs_plan_update=true and return the COMPLETE updated workout plan "
            "(all days, all exercises — not just the changed ones). "
            "The workout plan uses this exact structure: { name, totalDays, days: [{ day, focus, exercises: [{ name, sets, reps, restSeconds, equipment }] }] }. "
            "Return the full plan in this exact format — do NOT use 'workoutDays' key, use 'days'. "
            "INJURY HANDLING: If the user mentions pain, discomfort, or injury, "
            "and you don't already have enough info (body part, type of pain, when it occurs), "
            "ask ONE clarifying question in your answer and set injury_clarification_needed=true. "
            "Once you have enough info, set updated_injuries with the new/updated entries "
            "(each with id=new UUID or existing id, description, bodyPart, status='active'|'recovering'|'resolved', notes). "
            "When updating injuries, also update the workout plan to avoid the injured area. "
            "If pain/injury red flags are present, advise reducing load and seeing a clinician. "
            "IMPORTANT: updated_nutrition_plan must always be null — you only manage training. "
            "WORKOUT LOGGING: If the user tells you they completed a workout, trained a muscle group, "
            "did cardio, or any physical activity (today or recently), set logged_workouts with session data. "
            "Each entry needs: date (YYYY-MM-DD), focus (e.g. 'Legs', 'Upper Body', 'Cardio'), "
            "durationSeconds (estimate if not stated, default 3600), and exercises array "
            "(each with name and sets [{weightLbs, reps}] if mentioned). "
            "If they just say 'I did legs today' with no details, log it with an empty exercises array. "
            "Do NOT log workouts if the user is just asking about future plans or hypotheticals. "
            "Return JSON only."
            + _capability_instructions +
            "As a trainer you CANNOT modify the meal plan — if they ask about food or nutrition, "
            "tell them to switch to the Nutritionist chat for that."
        )

    workout_log_schema = (
        '  "logged_workouts": [{"date": "YYYY-MM-DD", "focus": "...", "durationSeconds": 3600, "exercises": [{"name": "...", "sets": [{"weightLbs": 0, "reps": 0}]}]}] or null,\n'
        if not is_nutritionist else
        '  "logged_workouts": null,\n'
    )
    injury_schema = (
        '  "updated_injuries": [{"id": "uuid", "description": "...", "bodyPart": "...", "status": "active|recovering|resolved", "notes": "..."}] or null,\n'
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
        + plan_schema
        + workout_log_schema
        + injury_schema +
        '}\n\n'
        "GOAL UPDATES: Set `updated_goal` ONLY when the user explicitly asks to change their fitness goal "
        "(e.g. 'I want to cut now', 'switch me to strength'). Otherwise leave it null. "
        "Never change the goal silently just because you think it would be better.\n"
        "IMPORTANT: If needs_plan_update is true, you MUST include the complete updated plan object "
        "(not just the changed parts - the full structure). Preserve all unchanged days/meals exactly.\n"
        "PLAN SETTING CHANGES: If the user asks to change training days, workout duration, or equipment, "
        "set needs_plan_update=true and return the FULL updated plan reflecting the change. "
        "For example, if they say 'make it 6 days', return a complete 6-day plan. "
        "Do NOT just say you've made the change — you must actually return the updated plan.\n"
        + (
            "WORKOUT PLAN FORMAT: updated_workout_plan must use this exact structure: "
            '{"name": "...", "totalDays": N, "days": [{"day": "Day 1", "focus": "...", "exercises": [{"name": "...", "sets": N, "reps": "...", "restSeconds": N, "equipment": "..."}]}]}'
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
    _topic_hints = {
        "change_plan": "The user wants to modify their workout or nutrition plan. Focus on plan changes.",
        "log_activity": "The user wants to log a workout or activity they completed. Focus on extracting date, focus, duration, and exercises.",
        "report_injury": "The user is reporting pain or an injury. Prioritise injury assessment, ask clarifying questions, and suggest exercise modifications.",
        "change_meals": "The user wants to modify their meal plan. Focus on meal/food swaps and macro adjustments.",
        "log_food": "The user wants to log food they ate. Focus on identifying foods, portions, and macros.",
        "general": "The user has a general question. Keep your answer concise and conversational.",
    }
    if topic and topic in _topic_hints:
        system_prompt += f"\n\nTOPIC CONTEXT: {_topic_hints[topic]}"

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
        print(f"[trainer-question] phase-1: needs_plan_update={result.get('needs_plan_update')} has_workout={bool(result.get('updated_workout_plan'))} has_nutrition={bool(result.get('updated_nutrition_plan'))} injuries={result.get('updated_injuries')} logged_workouts={len(result.get('logged_workouts') or [])}")

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


