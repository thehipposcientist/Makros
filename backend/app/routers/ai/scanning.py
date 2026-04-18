from __future__ import annotations

import json

import openai
from openai import OpenAI
from fastapi import HTTPException, Depends
from pydantic import BaseModel as _PydanticBaseModel

from app.auth import get_current_user
from app.models import User

from .router import router
from .models import (
    FoodPhotoRequest, ScanFoodsRequest, FoodNutritionSearchRequest, ExerciseSearchRequest,
    SupplementLookupRequest, SupplementPhotoRequest, FormPhotoRequest, BodyScanRequest,
    MealInstructionsRequest,
)
from .utils import (
    get_openai_api_key, model_meal_parsing, model_chat,
    _is_gpt5, _build_chat_kwargs, _chat_create, _extract_json,
    _log_openai_error,
    SCHEMA_FOOD_PHOTO, SCHEMA_SCAN_FOODS, SCHEMA_SUPPLEMENT_INFO,
    SCHEMA_SCAN_EQUIPMENT, SCHEMA_FORM_PHOTO,
    MICRONUTRIENT_AI_FIELDS, MICRONUTRIENT_PROMPT_GUIDE,
)


@router.post("/food-photo")
def analyze_food_photo(
    body: FoodPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Estimate meal contents and macros from a food photo."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    # Build a concrete JSON example with two real micronutrient fields so
    # the AI knows what shape to emit. Listing all 31 field names with no
    # values produced "{ fiber, sugar, ... }" output that wasn't valid JSON.
    micros_example = ", ".join(f'"{k}": 0' for k in MICRONUTRIENT_AI_FIELDS)
    _fp_messages = [
        {
            "role": "system",
            "content": (
                "You are a nutrition coach analyzing meal photos. Estimate likely meal contents and macros. "
                "Use practical ranges but return a single best estimate. Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Analyze this meal photo. Identify likely foods in plain English, "
                        "estimate total macros AND the full micronutrient panel, and provide a short meal name.\n\n"
                        f"{MICRONUTRIENT_PROMPT_GUIDE}\n\n"
                        "Return JSON in EXACTLY this shape (replace zeros with real values):\n"
                        '{"meal_name": "Chicken bowl", '
                        '"items": ["grilled chicken", "rice", "broccoli"], '
                        '"calories": 0, "protein": 0, "carbs": 0, "fat": 0, '
                        f'"micronutrients": {{{micros_example}}}}}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _fp_messages, json_schema=SCHEMA_FOOD_PHOTO, max_tokens=900, timeout_secs=45)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Food photo analysis failed: {str(e)}")


@router.post("/scan-foods")
def scan_foods_photo(
    body: ScanFoodsRequest,
    current_user: User = Depends(get_current_user),
):
    """Identify multiple individual food items from one or more photos, each with macros per serving."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.images:
        raise HTTPException(status_code=400, detail="At least one image is required")

    client = OpenAI(api_key=api_key)

    context_hint = f"\nExtra context from the user: {body.context}" if body.context else ""

    # Build content blocks: text prompt first, then all images
    micros_example = ", ".join(f'"{k}": 0' for k in MICRONUTRIENT_AI_FIELDS)
    user_content: list[dict] = [
        {
            "type": "text",
            "text": (
                f"List every individual food item you can identify across all provided image(s). "
                "For each one, provide a short common name, typical serving size, estimated macros, "
                "AND the full per-serving micronutrient panel.\n\n"
                f"{MICRONUTRIENT_PROMPT_GUIDE}\n"
                f"{context_hint}"
                "Return JSON in EXACTLY this shape (replace zeros with real values, one entry per food):\n"
                '{"foods": [{"name": "chicken breast", "serving": "6 oz", '
                '"calories": 0, "protein": 0, "carbs": 0, "fat": 0, '
                f'"micronutrients": {{{micros_example}}}}}]}}'
            ),
        }
    ]
    for img in body.images:
        image_data_url = f"data:{img.mime_type};base64,{img.image_base64}"
        user_content.append({"type": "image_url", "image_url": {"url": image_data_url}})

    _sf_messages = [
        {
            "role": "system",
            "content": (
                "You are a nutrition expert. Identify every distinct food item visible in the image(s). "
                "For each item, estimate its name, a typical serving size, and macros per that serving. "
                "Return valid JSON only."
            ),
        },
        {"role": "user", "content": user_content},
    ]
    try:
        # Bumped from 500 → 1500 to fit the full micronutrient panel for
        # multiple foods. With ~31 fields per food and 3-5 foods per scan,
        # 500 tokens truncated mid-object and produced invalid JSON.
        kwargs = _build_chat_kwargs(model_meal_parsing(), _sf_messages, json_schema=SCHEMA_SCAN_FOODS, max_tokens=1500, timeout_secs=45)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Food scan failed: {str(e)}")


@router.post("/food-search")
def food_nutrition_search(
    body: FoodNutritionSearchRequest,
    current_user: User = Depends(get_current_user),
):
    """Search for food nutrition info. Uses USDA FoodData Central first,
    falls back to AI only when USDA returns no results."""
    if not body.query.strip():
        raise HTTPException(status_code=400, detail="Query is required")

    # 1. Try USDA FoodData Central (free, accurate, fast)
    from app.services.usda_fdc import search_foods as usda_search
    usda_results = usda_search(body.query.strip(), max_results=5)
    if usda_results:
        print(f"[food-search] USDA hit: {len(usda_results)} results for '{body.query}'")
        return {"results": usda_results}

    # 2. Fallback to AI when USDA has no match
    print(f"[food-search] USDA miss for '{body.query}', falling back to AI")
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="No USDA results and OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    micros_example = ", ".join(f'"{k}": 0' for k in MICRONUTRIENT_AI_FIELDS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a USDA-grade nutrition database. Given a food query, return nutrition info "
                "INCLUDING the full micronutrient panel. "
                "If the user specifies a quantity (e.g. '100g chicken'), use that. "
                "If not, use a standard serving size. "
                "Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f'Food query: "{body.query}"\n\n'
                f"{MICRONUTRIENT_PROMPT_GUIDE}\n\n"
                "Return JSON in EXACTLY this shape (replace zeros with real values, one entry per result):\n"
                '{"results": [{"name": "chicken breast", "serving": "6 oz", '
                '"calories": 0, "protein": 0, "carbs": 0, "fat": 0, '
                f'"micronutrients": {{{micros_example}}}}}]}}\n\n'
                "Return 1-5 results. If the query is vague (e.g. 'chicken'), return common preparations. "
                "If specific (e.g. '6oz grilled chicken breast'), return exactly that."
            ),
        },
    ]
    try:
        resp = client.chat.completions.create(
            model=model_meal_parsing(),
            messages=messages,
            response_format={"type": "json_object"},
            max_tokens=1500,
            timeout=30,
        )
        data = json.loads(resp.choices[0].message.content or '{"results": []}')
        results = data if isinstance(data, list) else data.get("results", [])
        for r in results:
            r["source"] = "ai"
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Food search failed: {str(e)}")


@router.post("/exercise-search")
def exercise_ai_search(
    body: ExerciseSearchRequest,
    current_user: User = Depends(get_current_user),
):
    """Search for exercises. Tries wger.de database first (free, has images),
    falls back to AI for natural-language queries that wger can't match."""
    if not body.query.strip():
        raise HTTPException(status_code=400, detail="Query is required")

    # 1. Try wger.de first (free, structured, has images)
    try:
        from app.services.workout.wger_exercises import search_exercises as wger_search
        wger_results = wger_search(body.query.strip(), max_results=6)
        if wger_results:
            mapped = []
            for w in wger_results:
                mapped.append({
                    "name": w["name"],
                    "primary_muscle": (w.get("muscles") or [""])[0].lower().replace(" ", "_") if w.get("muscles") else "full_body",
                    "equipment": (w.get("equipment") or ["bodyweight"])[0].lower() if w.get("equipment") else "bodyweight",
                    "sets": 3,
                    "reps": "8-12",
                    "rest_seconds": 90,
                    "why": f"From wger.de exercise database",
                    "form_cues": [],
                    "image_url": w.get("image_url"),
                    "source": "wger",
                })
            print(f"[exercise-search] wger hit: {len(mapped)} results for '{body.query}'")
            return {"results": mapped}
    except Exception as e:
        print(f"[exercise-search] wger search failed: {e}")

    # 2. Fallback to AI
    print(f"[exercise-search] wger miss for '{body.query}', falling back to AI")
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="No wger results and OpenAI API key not configured")

    equipment_line = (
        f"User's available equipment: {', '.join(body.equipment)}"
        if body.equipment else "User's equipment: unknown — prefer common / bodyweight options"
    )
    muscle_line = f"Target muscle group: {body.muscle_group}" if body.muscle_group else ""
    injury_line = (
        f"Injuries to avoid: {', '.join(body.injuries)}. Do NOT suggest exercises that stress these areas."
        if body.injuries else ""
    )
    # Dedupe against the user's existing library — don't waste an AI slot
    # returning something they already have. We cap the list sent to the
    # prompt at ~40 names to keep token usage reasonable; the client also
    # filters belt-and-suspenders.
    exclude_line = ""
    if body.exclude:
        capped = body.exclude[:40]
        exclude_line = (
            "EXCLUDE these exercises — the user already has them in their library. "
            f"Do NOT return any of these names (case-insensitive): {', '.join(capped)}."
        )

    messages = [
        {
            "role": "system",
            "content": (
                "You are a strength and conditioning coach helping a user find exercises. "
                "Return 3–6 concrete exercise options that match the query AND the user's "
                "equipment and injury constraints. Each must be a real, well-known exercise "
                "— not an invented one. Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f'Exercise query: "{body.query}"\n'
                f"{equipment_line}\n"
                f"{muscle_line}\n"
                f"{injury_line}\n"
                f"{exclude_line}\n\n"
                "Return JSON with this exact schema:\n"
                '{"results": [{\n'
                '  "name": "exercise name",\n'
                '  "primary_muscle": "chest|back|shoulders|biceps|triceps|quads|hamstrings|glutes|calves|core|full_body",\n'
                '  "equipment": "barbell|dumbbell|machine|cable|bodyweight|kettlebell|band|other",\n'
                '  "sets": 3,\n'
                '  "reps": "8-12",\n'
                '  "rest_seconds": 90,\n'
                '  "why": "1 sentence on why this exercise fits the query + user constraints",\n'
                '  "form_cues": ["cue 1", "cue 2", "cue 3"]\n'
                '}]}\n\n'
                "Return 3–6 results ordered most→least relevant. "
                "If the query is vague (e.g. 'quads'), return a mix of compound and isolation movements. "
                "If the query is specific (e.g. 'unilateral glute bridge'), return that exact exercise plus 2–3 close variations."
            ),
        },
    ]

    client = OpenAI(api_key=api_key)
    try:
        resp = client.chat.completions.create(
            model=model_meal_parsing(),
            messages=messages,
            response_format={"type": "json_object"},
            max_tokens=800,
            timeout=20,
        )
        data = json.loads(resp.choices[0].message.content or '{"results": []}')
        results = data if isinstance(data, list) else data.get("results", [])
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Exercise search failed: {str(e)}")


@router.post("/meal-instructions")
def generate_meal_instructions(
    body: MealInstructionsRequest,
    current_user: User = Depends(get_current_user),
):
    """On-demand prep instructions for a single meal. Cheap, single AI call,
    returned as a short plain-text recipe. The client caches the result per
    meal so this only fires the first time the user taps "How to make this"."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.meal_name.strip():
        raise HTTPException(status_code=400, detail="meal_name is required")

    # Build a compact ingredient line. We keep this tight on purpose — the
    # prompt is ~150 input tokens so the call is a couple hundredths of a
    # cent per tap.
    ingredient_lines: list[str] = []
    for it in body.items or []:
        name = str(it.get("name") or "").strip()
        if not name:
            continue
        qty = it.get("quantity")
        unit = str(it.get("unit") or "").strip()
        if qty is not None and unit:
            ingredient_lines.append(f"- {qty} {unit} {name}")
        elif qty is not None:
            ingredient_lines.append(f"- {qty} {name}")
        else:
            ingredient_lines.append(f"- {name}")
    ingredients_block = "\n".join(ingredient_lines) if ingredient_lines else "(no ingredient list provided)"

    context_bits: list[str] = []
    if body.cooking_skill:
        context_bits.append(f"Cooking skill: {body.cooking_skill}")
    if body.prep_time_minutes:
        context_bits.append(f"Max prep time: {body.prep_time_minutes} minutes")
    if body.dietary_preference:
        context_bits.append(f"Diet: {body.dietary_preference}")
    if body.allergies:
        context_bits.append(f"Allergies (avoid): {', '.join(body.allergies)}")
    context_block = "\n".join(f"- {b}" for b in context_bits) if context_bits else "- No special constraints"

    variation_block = ""
    if body.previous_variants:
        # Give the AI the earlier recipes so it can deliberately vary from
        # them. Kept short (first 300 chars each) so the prompt stays cheap.
        previews = "\n\n".join(
            f"VARIATION {i+1}:\n{v[:300]}" for i, v in enumerate(body.previous_variants)
        )
        variation_block = (
            "\nTHE USER HAS ALREADY SEEN THESE PREPARATIONS — produce a "
            "DIFFERENT one using the same ingredients. Change cuisine, "
            "cooking technique, or flavor profile. Don't repeat the same "
            "approach:\n"
            f"{previews}\n"
        )

    prompt = (
        f"Give quick prep instructions for this meal:\n\n"
        f"MEAL: {body.meal_name}\n\n"
        f"INGREDIENTS:\n{ingredients_block}\n\n"
        f"USER CONTEXT:\n{context_block}\n"
        f"{variation_block}\n"
        "Return a SHORT recipe — 100 words max:\n"
        "  - 1 sentence describing the dish.\n"
        "  - 3-5 numbered steps, one line each.\n"
        "  - Time estimate at the end.\n"
        "  - Plain text, no markdown.\n"
        "Be direct. No filler. Example step: '1. Season chicken with salt and pepper.'"
    )

    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model_meal_parsing(),
            messages=[
                {"role": "system", "content": "You are a practical home cook. Return plain text only."},
                {"role": "user", "content": prompt},
            ],
            max_tokens=400,
            timeout=20,
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            raise ValueError("empty response")
        print(f"[meal-instructions] generated for '{body.meal_name}' ({len(text)} chars)")
        return {"instructions": text}
    except Exception as e:
        diag = _log_openai_error("meal-instructions", 1, model_meal_parsing(), e) if isinstance(e, (openai.APIStatusError, openai.APIConnectionError, openai.APITimeoutError)) else str(e)
        raise HTTPException(status_code=502, detail=f"Failed to generate instructions: {diag}")


@router.post("/supplement-info")
def get_supplement_info(
    body: SupplementLookupRequest,
    current_user: User = Depends(get_current_user),
):
    """Look up evidence-based info for any supplement by name."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Supplement name is required")

    _si_messages = [
        {
            "role": "system",
            "content": (
                "You are a sports nutrition expert with deep knowledge of supplements, "
                "their mechanisms, evidence base, and safe use. Always respond with valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f'Look up this supplement: "{body.name.strip()}"\n\n'
                "If it is a real, recognized supplement or ingredient, return a JSON object with:\n"
                '- "found": true\n'
                '- "name": canonical common name\n'
                '- "category": one of "Protein", "Performance", "Recovery", "Health", "Weight Management", "Sleep & Stress", "Other"\n'
                '- "tagline": one short sentence\n'
                '- "whatItDoes": 2-3 sentences on mechanism and benefits\n'
                '- "evidence": one of "strong", "moderate", or "limited"\n'
                '- "dose": typical effective dose with unit (e.g. "5g daily")\n'
                '- "timing": when to take it\n'
                '- "goodFor": array of 1-4 strings from: "Strength", "Muscle gain", "Fat loss", "Endurance", "Recovery", "General health", "Athletic performance", "Sleep"\n'
                '- "cautions": 1-2 sentences on side effects or who should avoid it\n\n'
                'If not a real supplement, return {"found": false, "name": "' + body.name.strip() + '"}'
            ),
        },
    ]
    client = OpenAI(api_key=api_key)
    try:
        kwargs = _build_chat_kwargs(model_chat(), _si_messages, json_schema=SCHEMA_SUPPLEMENT_INFO, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Supplement lookup failed: {str(e)}")


@router.post("/supplement-photo")
def get_supplement_from_photo(
    body: SupplementPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Identify a supplement from a photo of its label/packaging and return evidence-based info."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"

    _sp_messages = [
        {
            "role": "system",
            "content": (
                "You are a sports nutrition expert. Identify supplements from photos of labels, "
                "packaging, or pills, then provide evidence-based information. "
                "Always respond with valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Identify the supplement shown in this image. "
                        'If you can identify it, return {"found": true, "name": ..., "category": ..., '
                        '"tagline": ..., "whatItDoes": ..., "evidence": ..., "dose": ..., "timing": ..., '
                        '"goodFor": [...], "cautions": ...}. '
                        'If you cannot identify it, return {"found": false, "name": ""}.'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _sp_messages, json_schema=SCHEMA_SUPPLEMENT_INFO, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Supplement photo lookup failed: {str(e)}")


@router.post("/scan-equipment")
def scan_equipment_photo(
    body: FoodPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Identify gym equipment visible in a photo and return names matching the app's equipment library."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    known_equipment = [
        "Pull-up bar", "Resistance bands", "Yoga mat", "Jump rope", "Foam roller",
        "Ab wheel", "Dip bars", "Suspension trainer",
        "Dumbbells", "Barbell", "Kettlebell", "EZ curl bar", "Weight plates",
        "Trap bar", "Medicine ball",
        "Flat bench", "Adjustable bench", "Incline bench",
        "Squat rack", "Power rack", "Landmine attachment",
        "Cable machine", "Leg press", "Lat pulldown", "Chest press machine",
        "Seated row machine", "Leg extension", "Leg curl machine",
        "Shoulder press machine", "Hip abduction machine", "Hip adduction machine",
        "Smith machine", "Hack squat machine", "Assisted pull-up machine",
        "Treadmill", "Stationary bike", "Elliptical", "Rowing machine",
        "Stair climber", "Assault bike", "Swimming pool", "Battle ropes",
        "Plyo box", "Sled",
    ]

    _eq_messages = [
        {
            "role": "system",
            "content": (
                "You are a fitness equipment expert. Identify gym equipment visible in the image. "
                "Only return equipment names that exactly match items in the provided list. "
                "Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Identify all gym equipment visible in this image. "
                        f"Only include items whose names exactly match something in this list: {known_equipment}. "
                        'Return exactly this JSON: {"equipment": [<array of matching equipment name strings>]}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _eq_messages, json_schema=SCHEMA_SCAN_EQUIPMENT, max_tokens=150, timeout_secs=20)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Equipment scan failed: {str(e)}")


@router.post("/form-photo")
def analyze_form_photo(
    body: FormPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Analyze a form photo for quick coaching cues."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    _form_messages = [
        {
            "role": "system",
            "content": (
                "You are a workout form coach analyzing a single exercise photo. "
                "Provide practical setup/posture cues, likely muscle targeting notes, and obvious red flags. "
                "Do not pretend to diagnose injury from one image. Return JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Exercise: {body.exercise_name or 'unknown'}\n"
                        f"User concern: {body.question or 'General form check'}\n\n"
                        "Analyze this form photo. Return exactly this JSON schema: "
                        '{"answer": string, "quick_cues": [string], "likely_target": string, '
                        '"red_flags": [string], "safety_note": string}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_chat(), _form_messages, json_schema=SCHEMA_FORM_PHOTO, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Form photo analysis failed: {str(e)}")


@router.post("/body-scan")
def body_scan(
    body: BodyScanRequest,
    current_user: User = Depends(get_current_user),
):
    """Estimate body composition from a photo using AI vision."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    context_lines = []
    if body.gender:
        context_lines.append(f"Gender: {body.gender}")
    if body.weight_lbs:
        context_lines.append(f"Weight: {body.weight_lbs} lbs")
    if body.height_inches:
        feet = int(body.height_inches // 12)
        inches = int(body.height_inches % 12)
        context_lines.append(f"Height: {feet}'{inches}\"")
    if body.age:
        context_lines.append(f"Age: {body.age}")
    context_str = "\n".join(context_lines) if context_lines else "No additional info provided."

    _scan_messages = [
        {
            "role": "system",
            "content": (
                "You are an expert physique analyst and certified personal trainer. "
                "Analyze the provided photo to estimate body composition. "
                "Be honest but encouraging. This is an ESTIMATE — always include a disclaimer. "
                "Return JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"User info:\n{context_str}\n\n"
                        "Analyze this physique photo. Estimate body composition and provide feedback.\n\n"
                        "Return exactly this JSON:\n"
                        "{\n"
                        '  "bodyFatPct": number (estimated body fat percentage, e.g. 18.5),\n'
                        '  "bodyFatRange": string (e.g. "17-20%"),\n'
                        '  "muscleMass": string (one of: "low", "below_average", "average", "above_average", "high"),\n'
                        '  "category": string (e.g. "Athletic", "Lean", "Average", "Overweight"),\n'
                        '  "strengths": [string] (2-3 visible strong points),\n'
                        '  "improvements": [string] (2-3 areas to work on),\n'
                        '  "assessment": string (2-3 sentence overall assessment, encouraging tone),\n'
                        '  "disclaimer": string (brief note that this is a visual estimate)\n'
                        "}"
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_chat(), _scan_messages, json_schema=None, max_tokens=500, timeout_secs=40)
        response = _chat_create(client, **kwargs)
        result = _extract_json(response.choices[0].message.content)
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Body scan failed: {str(e)}")


# ─── Goal matcher ────────────────────────────────────────────────────────────


class GoalMatchRequest(_PydanticBaseModel):
    description: str


@router.post("/match-goal")
def match_goal(
    body: GoalMatchRequest,
):
    """Match a natural language description to the best fitness goal.

    No auth required — used during onboarding before the user has an account.
    Cheap call: ~100 input / ~50 output tokens."""
    api_key = get_openai_api_key()
    if not api_key:
        return {"goal_id": "body_recomp", "reason": "Default recommendation"}

    goals_list = (
        "build_muscle: Build muscle mass and size\n"
        "build_strength: Get stronger on compound lifts\n"
        "body_recomp: Lose fat and gain muscle simultaneously\n"
        "lose_fat: Lose weight and body fat\n"
        "endurance: Improve cardiovascular endurance and stamina\n"
        "athletic_performance: Build sport-ready fitness with power and conditioning\n"
        "general_health: Balanced fitness for longevity and wellness\n"
        "mental_wellness: Low-intensity movement for stress relief and mood\n"
    )
    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model_chat(),
            messages=[
                {"role": "system", "content": "You match user fitness descriptions to goals. Return JSON only."},
                {"role": "user", "content": (
                    f"The user said: \"{body.description}\"\n\n"
                    f"Available goals:\n{goals_list}\n"
                    "Pick the single best goal_id. Also return a one-sentence reason.\n"
                    '{"goal_id": "...", "reason": "..."}'
                )},
            ],
            response_format={"type": "json_object"},
            max_tokens=100,
            timeout=10,
        )
        result = json.loads(resp.choices[0].message.content or "{}")
        goal_id = result.get("goal_id", "body_recomp")
        reason = result.get("reason", "")
        valid_ids = {"build_muscle", "build_strength", "body_recomp", "lose_fat",
                     "endurance", "athletic_performance", "general_health", "mental_wellness"}
        if goal_id not in valid_ids:
            goal_id = "body_recomp"
        return {"goal_id": goal_id, "reason": reason}
    except Exception as e:
        print(f"[match-goal] failed: {e}")
        return {"goal_id": "body_recomp", "reason": "Default recommendation"}
