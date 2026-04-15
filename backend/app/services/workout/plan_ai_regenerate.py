"""AI plan regeneration fallback.

When the deterministic planner ships a plan and the AI reviewer flags
it as broken — either `status="modify"` with patches, or `status="ok"`
with a contradiction ("ok-with-complaints") — this module asks the
LLM to build a fresh replacement plan from scratch.

Unlike `plan_review`, which only proposes surgical patches, this path
is a full generator: the AI receives the equipment catalog, the
user's goal, recent completed workouts, and injury context, then
returns a complete multi-day plan matching the existing response
schema. The caller re-stamps set schemes / target loads on the
returned plan so progression metadata still flows.

Failure modes (no API key, bad JSON, empty days, exercise names the
user doesn't own equipment for) all return `None` so the caller
falls back to the original deterministic plan.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional


# ── Types ────────────────────────────────────────────────────────────


@dataclass
class AiRegenResult:
    plan: dict                      # {workout_plan: {days: [...]}} replacement
    notes: str                      # AI rationale text for logging / trainer note
    used_exercise_names: list[str]  # names the AI picked (for coverage tracking)


# ── Equipment-aware exercise catalog ─────────────────────────────────


def _filter_catalog_for_user(
    all_exercises: list[dict],
    owned_slugs: set[str] | None,
) -> list[dict]:
    """Trim the seed catalog to exercises the user can actually
    perform with their equipment. Bodyweight + cardio machines they
    own are always allowed; anything requiring a missing piece of
    gear is dropped. When `owned_slugs` is None/empty, returns the
    full catalog (the AI picks conservatively with bodyweight).
    """
    if not owned_slugs:
        return list(all_exercises)
    out: list[dict] = []
    for ex in all_exercises:
        eq = ex.get("equipment") or []
        # Required primary equipment — every slug in `required` must
        # be in owned_slugs, or the exercise is bodyweight.
        required = [e.get("slug") for e in eq if e.get("role") == "primary"]
        if not required:
            out.append(ex)
            continue
        if all(slug and slug in owned_slugs for slug in required):
            out.append(ex)
    return out


def _compact_catalog_for_prompt(catalog: list[dict], *, max_items: int = 120) -> list[dict]:
    """Shrink each catalog row to the minimal fields the AI needs to
    pick a good exercise: name, primary muscle, movement pattern,
    compound/isolation, equipment label. Capped at `max_items` to
    keep the prompt under ~8k tokens even for huge seed sets.

    The cap prefers lifting compounds first, then isolation, then
    cardio — so a truncated catalog still has the strength backbone
    the AI needs to build a balanced plan.
    """
    rows: list[dict] = []
    for ex in catalog:
        eq_slugs = [e.get("slug") for e in (ex.get("equipment") or []) if e.get("slug")]
        rows.append({
            "name": ex.get("name"),
            "primary_muscle": ex.get("primary_muscle"),
            "movement_pattern": ex.get("movement_pattern"),
            "is_compound": bool(ex.get("is_compound")),
            "category": ex.get("category") or ex.get("training_type"),
            "equipment": ", ".join([s for s in eq_slugs if s]) or "bodyweight",
        })
    # Sort: compound lifts first, isolation next, cardio/mobility last.
    def _priority(r: dict) -> int:
        cat = (r.get("category") or "").lower()
        if r.get("is_compound") and cat in ("strength", "hypertrophy", ""):
            return 0
        if cat in ("strength", "hypertrophy", ""):
            return 1
        if cat in ("conditioning", "cardio"):
            return 2
        return 3
    rows.sort(key=_priority)
    return rows[:max_items]


# ── AI call ──────────────────────────────────────────────────────────


_SYSTEM_PROMPT = """You are an expert strength & conditioning coach. You are being \
asked to generate a REPLACEMENT workout plan because a deterministic planner's \
first attempt failed review. Your plan will be used directly — there is no \
downstream fixer. Build a coherent, goal-appropriate week.

You will receive:
- `goal_bucket` — the user's PRIMARY training goal (dominant shaper of plan structure)
- `secondary_goal` — optional side-goal to accommodate without compromising the primary
- `goal_details` — free-form onboarding detail dict (target weight, deadline, etc.)
- `focused_muscle` — optional muscle group the user asked to emphasize. When present, \
  your plan MUST give this muscle clearly extra exposure: add a dedicated isolation \
  exercise on every lifting day that hits the relevant region (upper body emphasis \
  on upper days, lower on lower days), OR bias the compound selection toward \
  exercises whose primary_muscle matches. Do NOT ignore focused_muscle.
- experience, days/week, injuries, session_minutes
- `recent_completed`: the user's last ~3 days of training (focus labels; per-exercise \
  data may be empty — use the `focus` string as ground truth for what they trained)
- `exercise_catalog`: the EXACT set of exercises you may choose from. Use the \
  `name` field verbatim in your output. Do NOT invent exercises not in this list.
- `review_notes`: what the reviewer said was wrong with the previous plan. Fix \
  those issues in your output.
- `previous_plan_days`: the day structure the deterministic planner tried (for \
  context only — you are not obligated to match it).

Rules:
- Respect recent training: if the user trained upper body yesterday, DON'T schedule \
  upper body today. Legs yesterday → don't schedule legs today. Pull yesterday → \
  don't schedule pull/upper pulling today.
- Respect the goal_bucket:
    * body_recomp / fat_loss → lifting backbone WITH 1-2 cardio days (≥1 easy zone 2)
    * muscle_gain → lifting-dominant, minimal cardio
    * strength → lower rep ranges (4-6 on compounds), long rest, no 15-rep volume
    * endurance → cardio-dominant, 1 strength maintenance day
    * general_health → balanced, moderate intensity
- Honor injuries: if `injuries` contains "knee", do NOT program heavy squats, \
  lunges, or deep leg work. Use machines or unilateral isolation.
- NEVER schedule same-focus days back to back. Push/Push, Legs/Legs, Pull/Pull \
  are all invalid adjacencies. Upper/Lower alternation is preferred for 4-day \
  lifting weeks.
- Each lifting day should have 4-6 exercises. Each cardio day should have exactly \
  ONE exercise (the user picks a modality). Mobility days: 2-3 exercises.
- Use rep ranges that match the goal. Compounds at 4-6 (strength) or 6-8 \
  (hypertrophy/recomp); isolation at 10-15.
- Rest seconds: 150+ for heavy compounds, 90 for accessories, 60 for isolation, \
  30-60 for cardio intervals.

Return ONLY valid JSON in this shape:
{
  "notes": "one-paragraph rationale explaining the structural choices you made",
  "days": [
    {
      "day": "Day 1",
      "focus": "Upper",
      "exercises": [
        {"name": "<exact name from catalog>", "sets": N, "reps": "6-8",
         "rest_seconds": 150, "equipment": "<exact equipment string from catalog>"}
      ]
    },
    ...one entry per day in days_per_week...
  ]
}

Every exercise name you emit MUST appear in the `exercise_catalog.name` field. \
If you can't find a suitable exercise for a role, pick the closest one from the \
catalog rather than inventing a name.
"""


_REGEN_JSON_SCHEMA = {
    "name": "plan_regenerate",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["notes", "days"],
        "properties": {
            "notes": {"type": "string"},
            "days": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["day", "focus", "exercises"],
                    "properties": {
                        "day": {"type": "string"},
                        "focus": {"type": "string"},
                        "exercises": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["name", "sets", "reps", "rest_seconds", "equipment"],
                                "properties": {
                                    "name": {"type": "string"},
                                    "sets": {"type": "integer"},
                                    "reps": {"type": "string"},
                                    "rest_seconds": {"type": "integer"},
                                    "equipment": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}


def regenerate_plan_with_ai(
    *,
    failed_plan: dict,
    review_notes: str,
    goal: str,
    days_per_week: int,
    experience: str,
    injuries: tuple[str, ...] | list[str],
    focused_muscle: Optional[str],
    secondary_goal: Optional[str] = None,
    goal_details: Optional[dict] = None,
    session_minutes: Optional[int],
    recent_completed: list[dict],
    all_exercises: list[dict],
    owned_equipment_slugs: Optional[set[str]] = None,
) -> Optional[AiRegenResult]:
    """Call AI to generate a full replacement plan. Returns None on
    any failure so the caller keeps the deterministic plan.

    The catalog passed to the AI is filtered to what the user can
    actually use with their equipment. If the AI picks exercises NOT
    in the catalog, those are dropped from the output and the call
    still returns a (partial) plan — callers should sanity-check the
    day count afterward.
    """
    try:
        from openai import OpenAI
        from ...routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_plan_generation,
        )
    except Exception as exc:
        print(f"[plan_ai_regenerate] import failed: {exc}")
        return None

    try:
        api_key = get_openai_api_key()
    except Exception:
        return None
    if not api_key:
        print("[plan_ai_regenerate] skipped — no OpenAI API key configured")
        return None

    catalog = _filter_catalog_for_user(all_exercises, owned_equipment_slugs)
    compact_catalog = _compact_catalog_for_prompt(catalog, max_items=120)
    if not compact_catalog:
        print("[plan_ai_regenerate] skipped — empty catalog after filter")
        return None

    # Compact previous-plan summary: just day+focus+exercise names,
    # no loads or set schemes. The AI shouldn't anchor on the
    # deterministic plan's exact set/rep prescription.
    wp = (failed_plan or {}).get("workout_plan", {}) or {}
    previous_days = []
    for d in wp.get("days", []) or []:
        previous_days.append({
            "day": d.get("day"),
            "focus": d.get("focus"),
            "exercise_names": [e.get("name") for e in (d.get("exercises") or [])],
        })

    recent_summary = []
    for r in (recent_completed or [])[:6]:
        recent_summary.append({
            "focus": r.get("focus") or r.get("focus_label") or "",
            "workout_date": str(r.get("workout_date") or ""),
        })

    user_payload = {
        "goal_bucket": goal,
        "secondary_goal": secondary_goal,
        "goal_details": goal_details,
        "days_per_week": days_per_week,
        "experience": experience,
        "injuries": list(injuries or ()),
        "focused_muscle": focused_muscle,
        "session_minutes": session_minutes,
        "recent_completed": recent_summary,
        "review_notes": review_notes,
        "previous_plan_days": previous_days,
        "exercise_catalog": compact_catalog,
    }

    try:
        client = OpenAI(api_key=api_key)
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": (
                "Generate a replacement workout plan. Respond with JSON only.\n\n"
                + json.dumps(user_payload, indent=2)
            )},
        ]
        kwargs = _build_chat_kwargs(
            model_plan_generation(),
            messages,
            json_schema=_REGEN_JSON_SCHEMA,
            max_tokens=4500,
            timeout_secs=60,
        )
        print(
            f"[plan_ai_regenerate] calling AI — catalog={len(compact_catalog)} "
            f"days={days_per_week} goal={goal}"
        )
        response = _chat_create(client, **kwargs)
        raw = response.choices[0].message.content or ""
        parsed = _extract_json(raw)
    except Exception as exc:
        print(f"[plan_ai_regenerate] AI call failed: {exc}")
        return None

    ai_days = parsed.get("days") or []
    if not isinstance(ai_days, list) or not ai_days:
        print(f"[plan_ai_regenerate] AI returned empty days list")
        return None
    if len(ai_days) != days_per_week:
        print(
            f"[plan_ai_regenerate] AI returned {len(ai_days)} days, "
            f"expected {days_per_week} — accepting anyway"
        )

    # Build a name → seed-row index so we can stamp the canonical
    # name (and catch AI hallucinations).
    by_name = {ex.get("name", "").lower(): ex for ex in all_exercises}
    valid_days: list[dict] = []
    dropped = 0
    used_names: list[str] = []
    for di, d in enumerate(ai_days):
        exs_in = d.get("exercises") or []
        exs_out = []
        for ei, e in enumerate(exs_in):
            name = (e.get("name") or "").strip()
            if not name:
                dropped += 1
                continue
            seed = by_name.get(name.lower())
            if seed is None:
                # Substring fallback — AI sometimes abbreviates.
                for candidate_name, candidate_row in by_name.items():
                    if name.lower() in candidate_name or candidate_name in name.lower():
                        seed = candidate_row
                        name = candidate_row.get("name", name)
                        break
            if seed is None:
                dropped += 1
                continue
            exs_out.append({
                "name": name,
                "sets": int(e.get("sets") or 3),
                "reps": str(e.get("reps") or "8-12"),
                "restSeconds": int(e.get("rest_seconds") or 90),
                "equipment": str(e.get("equipment") or ""),
                # Internal metadata so downstream load-stamping works.
                "_slug": seed.get("slug"),
                "_role": "primary" if ei == 0 else ("secondary" if ei < 3 else "isolation"),
                "_primary_muscle": seed.get("primary_muscle"),
                "_secondary_muscles": list(seed.get("secondary_muscles") or []),
                "_rir_target": 2.0,
                "_ai_regenerated": True,
            })
            used_names.append(name)
        if exs_out:
            valid_days.append({
                "day": d.get("day") or f"Day {di + 1}",
                "focus": d.get("focus") or "",
                "exercises": exs_out,
            })
    if not valid_days:
        print(
            f"[plan_ai_regenerate] AI returned {len(ai_days)} days but zero valid "
            f"after catalog match (dropped {dropped} exercises)"
        )
        return None

    out_plan = {
        "workout_plan": {
            "name": f"AI Revised Plan",
            "totalDays": len(valid_days),
            "days": valid_days,
            "planner_mode": "ai_regenerate",
            "goal_bucket": goal,
            "source": "ai_regenerate",
        },
        "trainerNote": "",
    }
    notes = str(parsed.get("notes") or "")
    print(
        f"[plan_ai_regenerate] success — {len(valid_days)} days, "
        f"{sum(len(d['exercises']) for d in valid_days)} exercises, "
        f"dropped={dropped}"
    )
    return AiRegenResult(
        plan=out_plan,
        notes=notes,
        used_exercise_names=used_names,
    )
