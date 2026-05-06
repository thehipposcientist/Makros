"""AI-layered supplement recommendations.

Sits ON TOP of `supplement_recs.build_recommendations` (deterministic
floor). The AI layer's job is to surface supplements the deterministic
engine doesn't know about — adaptogens (ashwagandha, rhodiola), niche
performance (tongkat ali, tudca, urolithin A), context-specific
(CoQ10 for statin users, methylated B vitamins for MTHFR carriers,
collagen for joint goals, etc.) — and reason across signals the simple
rule-based engine can't compose.

Architecture:
  1. Build the deterministic rec set first (cheap, instant).
  2. Hash the user's input signature (goal + stack ids + age decade +
     diet shape).
  3. If cached AI recs exist with same signature AND <14d old, use them.
  4. Otherwise call the AI with full context, ask for 2-4 ADDITIONAL
     suggestions NOT already in the deterministic list.
  5. Cache the result.

Cost: ~$0.0003 per call × ~2 calls/month/user.

Safety guardrails:
  - Cautious language ("may support", "consider"). NEVER "boosts hormones",
    "prevents disease", "fixes".
  - Evidence_tier honestly reported (limited / moderate / strong).
  - Risk_tier flagged for anything with interactions (StJohnsWort, etc).
  - "Discuss with clinician" footer required on anything above moderate risk.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

logger = logging.getLogger(__name__)

CACHE_TTL_DAYS = 14


def compute_signature(
    goal: str,
    stack_slugs: list[str],
    age: int | None,
    gender: str,
    plant_protein_pct: float,
    fiber_g: float,
    omega3: float,
    hard_sessions_14d: int,
) -> str:
    """Deterministic input-hash. Two users with the same hash get the
    same AI recs (assuming same library version)."""
    # Coarsen continuous values so small day-to-day fluctuations don't
    # invalidate the cache. Goal type, sex, decade-of-age, stack
    # composition, and broad diet/training brackets are what matter.
    age_decade = (age // 10) * 10 if age else 0
    diet_bracket = (
        f"plant{int(plant_protein_pct // 20) * 20}"
        f"_fiber{int(fiber_g // 5) * 5}"
        f"_o3{1 if omega3 >= 1 else 0}"
    )
    train_bracket = "lo" if hard_sessions_14d < 3 else "mid" if hard_sessions_14d < 6 else "hi"
    payload = json.dumps({
        "goal": goal,
        "stack": sorted(stack_slugs),
        "age_decade": age_decade,
        "gender": gender,
        "diet": diet_bracket,
        "train": train_bracket,
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _build_prompt(context: dict, deterministic_slugs: list[str]) -> str:
    """Compose the user message for the AI. Includes profile, goal,
    stack, recent diet + training. Asks for ADDITIONAL recs the
    deterministic engine missed."""
    return f"""You are a cautious supplement consultant. Recommend 2-4 additional supplements for this user that are NOT in the list of recommendations they've already seen. Prioritize evidence-backed options personalized to their context.

USER PROFILE:
- Age: {context.get('age', 'unknown')}
- Gender: {context.get('gender', 'unspecified')}
- Weight: {context.get('weight_lbs', 'unknown')} lbs
- Goal: {context.get('goal', 'unspecified')}

CURRENT STACK ({len(context.get('stack_slugs', []))} items):
{chr(10).join('- ' + s for s in context.get('stack_slugs', [])) or '(empty)'}

RECENT TRAINING (last 14 days):
- Sessions: {context.get('sessions_14d', 0)}
- Hard sessions: {context.get('hard_sessions_14d', 0)}
- Cardio sessions: {context.get('cardio_sessions_14d', 0)}
- Total minutes: {context.get('total_minutes', 0):.0f}

DIET (14-day average):
- Calories: {context.get('avg_calories', 0):.0f}
- Protein: {context.get('avg_protein_g', 0):.0f}g/day
- Fiber: {context.get('avg_fiber_g', 0):.0f}g/day
- Omega-3 servings/14d: {context.get('omega3_servings', 0):.0f}
- Plant protein share: {context.get('plant_protein_pct', 0):.0f}%
- Fermented foods/14d: {context.get('fermented_servings', 0):.0f}

DETERMINISTIC ENGINE ALREADY RECOMMENDED THESE — DO NOT REPEAT:
{', '.join(deterministic_slugs) or '(none)'}

INSTRUCTIONS:
- Suggest 2-4 additional supplements the deterministic engine missed.
- Examples of supplements outside the standard list: ashwagandha, rhodiola, l-theanine, glycine, collagen, glucosamine, MSM, lion's mane, alpha-GPC, citicoline, CoQ10, NAD+ precursors, tudca, urolithin A, tongkat ali, etc.
- Each suggestion MUST be tied to a specific signal in the user's data.
- Use cautious language: "may support", "consider", "useful for". NEVER "fixes", "boosts hormones", "prevents disease".
- Honest evidence_tier: strong (multiple RCTs), moderate (some evidence), limited (preliminary).
- Skip anything with major drug interactions unless flagged with risk_tier="moderate" or "high" + clear "discuss with a clinician" guidance.

Return ONLY valid JSON in this shape:
{{
  "recommendations": [
    {{
      "slug": "ashwagandha_ksm66",
      "title": "Ashwagandha may support stress + sleep quality",
      "reason": "Specific reason tied to this user's signals.",
      "cautious_guidance": "Dose, timing, cautions. 'Discuss with clinician' if needed.",
      "evidence_tier": "moderate",
      "risk_tier": "low",
      "priority": "moderate",
      "signals": ["signal 1", "signal 2"]
    }}
  ]
}}
"""


def _call_ai(prompt: str, *, user_id: int | None = None) -> dict | None:
    """Synchronous AI call. Returns parsed JSON or None on failure.
    Errors are logged + non-fatal — caller falls through to no AI recs."""
    try:
        from app.routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            get_openai_api_key,
            model_chat,
        )
        api_key = get_openai_api_key()
        if not api_key:
            return None
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        messages = [
            {"role": "system", "content": "You return only valid JSON. No prose, no markdown fences."},
            {"role": "user", "content": prompt},
        ]
        kwargs = _build_chat_kwargs(
            model_chat(),
            messages,
            max_tokens=900,
            timeout_secs=30,
            ai_route="/supplements/ai-recs",
            ai_user_id=user_id,
            ai_budget_bucket="supplement_lookup",
        )
        resp = _chat_create(
            client,
            **kwargs,
        )
        text = resp.choices[0].message.content or "{}"
        return json.loads(text)
    except Exception as e:
        logger.warning(f"[supplement_ai_recs] AI call failed: {e}")
        return None


def get_or_generate_ai_recs(
    db: Session,
    user_id: int,
    *,
    deterministic_slugs: list[str],
    force_refresh: bool = False,
) -> dict:
    """Return AI-augmented recs. Reads cache if fresh + signature matches.
    Otherwise generates a new set and caches it.

    Returns:
      {
        "recommendations": [...],   # AI-suggested, may be empty
        "generated_at": ISO,
        "from_cache": bool,
      }
    """
    from app.models import (
        SupplementAICache, SupplementIngredient, UserSupplementStack,
        UserGoal, UserProfile, WorkoutCompletion,
    )
    from app.services.nutrition.gut_health import compute_weekly_rollup
    from datetime import date, timedelta as _td

    # ── Build context (mirrors supplement_recs.build_recommendations) ──
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    goal_row = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
        .order_by(UserGoal.created_at.desc())
    ).first()
    stack_rows = db.exec(
        select(UserSupplementStack).where(
            UserSupplementStack.user_id == user_id,
            UserSupplementStack.active == True,  # noqa: E712
        )
    ).all()
    stack_slugs: list[str] = []
    for it in stack_rows:
        if it.supplement_ingredient_id:
            ing = db.get(SupplementIngredient, it.supplement_ingredient_id)
            if ing:
                stack_slugs.append(ing.slug)

    try:
        rollup = compute_weekly_rollup(db, user_id=user_id, days=14)
    except Exception:
        rollup = {}

    omega3 = rollup.get("omega3_servings", 0) or 0
    fiber_g = rollup.get("avg_fiber_g", 0) or 0
    plant_protein = rollup.get("avg_plant_protein_g", 0) or 0
    animal_protein = rollup.get("avg_animal_protein_g", 0) or 0
    plant_protein_pct = (
        plant_protein / (plant_protein + animal_protein) * 100
        if (plant_protein + animal_protein) > 0 else 0
    )

    cutoff = date.today() - _td(days=14)
    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= cutoff)
    ).all()
    sessions_14d = len(completions)
    hard_sessions_14d = sum(
        1 for c in completions
        if (c.duration_seconds or 0) >= 45 * 60
        and (c.intensity or "").lower() in ("hard", "moderate")
    )
    cardio_sessions_14d = sum(
        1 for c in completions
        if "cardio" in (c.focus_label or "").lower()
        or "zone" in (c.focus_label or "").lower()
    )
    total_minutes = sum((c.duration_seconds or 0) for c in completions) / 60.0

    age = profile.age if profile else None
    weight_lbs = profile.weight_lbs if profile else None
    gender = (profile.gender.value if profile and profile.gender else "unspecified")
    goal = goal_row.goal_type.value.lower() if goal_row and goal_row.goal_type else "general_health"

    sig = compute_signature(
        goal=goal, stack_slugs=stack_slugs, age=age, gender=gender,
        plant_protein_pct=plant_protein_pct, fiber_g=fiber_g,
        omega3=omega3, hard_sessions_14d=hard_sessions_14d,
    )

    # ── Cache check ────────────────────────────────────────────────
    cache_row = db.exec(
        select(SupplementAICache).where(SupplementAICache.user_id == user_id)
    ).first()
    now_utc = datetime.now(timezone.utc)
    if cache_row and not force_refresh:
        cached_at = cache_row.generated_at
        # Make timezone-aware for comparison if naive (Postgres can return either)
        if cached_at.tzinfo is None:
            cached_at = cached_at.replace(tzinfo=timezone.utc)
        is_fresh = (now_utc - cached_at) < timedelta(days=CACHE_TTL_DAYS)
        sig_matches = cache_row.signature == sig
        if is_fresh and sig_matches:
            return {
                "recommendations": (cache_row.recs_json or {}).get("recommendations", []),
                "generated_at": cached_at.isoformat(),
                "from_cache": True,
            }

    # ── Generate via AI ────────────────────────────────────────────
    context = {
        "age": age, "gender": gender, "weight_lbs": weight_lbs, "goal": goal,
        "stack_slugs": stack_slugs,
        "sessions_14d": sessions_14d,
        "hard_sessions_14d": hard_sessions_14d,
        "cardio_sessions_14d": cardio_sessions_14d,
        "total_minutes": total_minutes,
        "avg_calories": rollup.get("avg_calories", 0) or 0,
        "avg_protein_g": rollup.get("avg_protein_g", 0) or 0,
        "avg_fiber_g": fiber_g,
        "omega3_servings": omega3,
        "plant_protein_pct": plant_protein_pct,
        "fermented_servings": rollup.get("fermented_servings", 0) or 0,
    }
    prompt = _build_prompt(context, deterministic_slugs)
    parsed = _call_ai(prompt, user_id=user_id)
    if not parsed or not isinstance(parsed.get("recommendations"), list):
        # AI failed — return empty without caching, so next call retries.
        return {"recommendations": [], "generated_at": now_utc.isoformat(), "from_cache": False}

    recs = []
    for r in parsed["recommendations"]:
        if not isinstance(r, dict):
            continue
        # Sanitize required fields
        recs.append({
            "slug": (r.get("slug") or "").strip().lower() or None,
            "title": str(r.get("title") or "").strip()[:120],
            "reason": str(r.get("reason") or "").strip()[:400],
            "cautious_guidance": str(r.get("cautious_guidance") or "").strip()[:600],
            "evidence_tier": r.get("evidence_tier") if r.get("evidence_tier") in ("strong", "moderate", "limited") else "limited",
            "risk_tier": r.get("risk_tier") if r.get("risk_tier") in ("low", "moderate", "high") else "low",
            "priority": r.get("priority") if r.get("priority") in ("high", "moderate", "low") else "low",
            "signals": [str(s)[:160] for s in (r.get("signals") or []) if s][:6],
            "ai_generated": True,
        })

    # Drop any rec whose slug duplicates the deterministic set (safety
    # net — the prompt asks for non-duplicates but trust-but-verify).
    deterministic_set = set(s for s in deterministic_slugs if s)
    recs = [r for r in recs if (r["slug"] not in deterministic_set if r["slug"] else True)]

    # ── Cache ──────────────────────────────────────────────────────
    payload = {"recommendations": recs}
    if cache_row:
        cache_row.signature = sig
        cache_row.recs_json = payload
        cache_row.generated_at = now_utc
        db.add(cache_row)
    else:
        db.add(SupplementAICache(
            user_id=user_id, signature=sig, recs_json=payload,
            generated_at=now_utc,
        ))
    db.commit()

    return {
        "recommendations": recs,
        "generated_at": now_utc.isoformat(),
        "from_cache": False,
    }
