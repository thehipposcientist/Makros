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
import logging
from dataclasses import dataclass
from typing import Any, Optional


logger = logging.getLogger(__name__)


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


# ── Post-assembly adjacency repair ───────────────────────────────────
#
# The deterministic planner has a four-tier adjacency repair sweep
# inside `weekly_recipe._repair_adjacent_duplicates`, but it operates
# on `DayArchetype` enums. AI-regenerated plans bypass that pipeline
# entirely — the LLM emits free-form focus strings ("Push", "Upper",
# "Back & Biceps") and the plan ships directly to the client. When the
# AI puts two same-family days back to back (Push → Push, or Pull →
# Upper for a U/L user), nothing downstream catches it.
#
# This helper re-implements adjacency repair at the focus-string
# layer: it normalizes each day's focus to a focus family via
# `normalize_focus_to_family`, expands to the coarse bucket via
# `_FINE_TO_COARSE`, and swaps entire day dicts (preserving every
# exercise) to break any same-family OR same-bucket adjacency. Each
# swap preserves the exact exercises, set schemes, and load metadata —
# only the position in the `days` list changes.
#
# Returns `(repaired_days, ok)` where `ok` is True iff the final
# sequence has zero adjacency violations at both family and bucket
# levels. Callers should fall back to the deterministic plan when
# `ok=False`.


def _repair_focus_adjacency(days: list[dict]) -> tuple[list[dict], bool]:
    """Swap day positions to break same-family / same-bucket adjacencies.

    Works on the AI-assembled day dicts directly — the exercises, set
    schemes, and load metadata in each day are preserved; only the
    ordering inside the `days` list changes.

    Adjacency is checked at two granularities:
      1. Focus family (push / pull / legs / upper / lower / full_body /
         cardio / mobility / recovery) — catches Push → Push, Legs →
         Legs, etc.
      2. Coarse bucket (upper_body / lower_body / full_body / cardio /
         mobility / recovery) — catches Pull → Upper for U/L users
         where both collapse to `upper_body`.

    Unknown focus labels (normalize returns None) are skipped for
    adjacency purposes — we can't know what they are, and refusing to
    place an unknown next to anything would over-constrain the solver.

    Strategy mirrors the deterministic `_repair_adjacent_duplicates`
    but simplified for free-form focus strings:
      - Scan left-to-right for adjacent-violating pairs (i-1, i).
      - Try swapping day `i` with every other position `j != i-1`; pick
        the swap that strictly reduces the total violation count.
      - If no improving swap exists, also try swapping position `i-1`.
      - Bounded loop of at most `len(days)` iterations.

    Returns (repaired_days, ok). `ok` is True iff zero violations remain.
    """
    from .focus_normalize import normalize_focus_to_family
    from .weekly_recipe import _FINE_TO_COARSE

    def _family(day: dict) -> Optional[str]:
        return normalize_focus_to_family(day.get("focus") or "")

    def _bucket(fam: Optional[str]) -> Optional[str]:
        if fam is None:
            return None
        return _FINE_TO_COARSE.get(fam, fam)

    # "Coarse" fine-family labels — these collapse a whole coarse bucket
    # into a single day (Upper hits push AND pull; Lower hits legs).
    # Adjacency between a coarse split label and any fine family in the
    # same bucket is a violation (Pull → Upper means upper-body
    # muscles trained two days in a row). A fine-to-fine coarse match
    # inside PPL (Push → Pull) is NOT a violation — PPL legitimately
    # alternates within the upper_body bucket.
    _COARSE_SPLIT_FAMILIES = {"upper", "lower"}

    def _is_violation(fa_prev: Optional[str], fa_curr: Optional[str]) -> bool:
        if fa_prev is None or fa_curr is None:
            return False
        if fa_prev == fa_curr:
            return True
        bk_prev = _bucket(fa_prev)
        bk_curr = _bucket(fa_curr)
        if bk_prev is None or bk_prev != bk_curr:
            return False
        # Same coarse bucket, different fine families. Violation only
        # when one side is a coarse split label (upper/lower) — Push →
        # Pull inside PPL is deliberately allowed.
        return (
            fa_prev in _COARSE_SPLIT_FAMILIES
            or fa_curr in _COARSE_SPLIT_FAMILIES
        )

    def _violations(lst: list[dict]) -> int:
        total = 0
        for i in range(1, len(lst)):
            if _is_violation(_family(lst[i - 1]), _family(lst[i])):
                total += 1
        return total

    out = list(days)
    max_iters = len(out) + 2
    for _ in range(max_iters):
        start = _violations(out)
        if start == 0:
            break
        progress = False
        # Walk left-to-right, find first violating pair, try to repair.
        for i in range(1, len(out)):
            if not _is_violation(_family(out[i - 1]), _family(out[i])):
                continue
            # Try swapping either endpoint with every other position,
            # pick the swap that most reduces the violation count.
            best_swap: tuple[int, int] | None = None
            best_count = start
            for endpoint in (i, i - 1):
                for j in range(len(out)):
                    if j == endpoint:
                        continue
                    test = list(out)
                    test[endpoint], test[j] = test[j], test[endpoint]
                    nv = _violations(test)
                    if nv < best_count:
                        best_count = nv
                        best_swap = (endpoint, j)
            if best_swap is not None:
                a, b = best_swap
                out[a], out[b] = out[b], out[a]
                logger.debug(
                    "[plan_ai_regenerate] adjacency-repair: swapped day "
                    "%d <-> %d (violations %d -> %d)",
                    a, b, start, best_count,
                )
                progress = True
                break
        if not progress:
            break

    # Rewrite sequential `day` labels so the output reads Day 1..N
    # regardless of which positions got swapped.
    for idx, day in enumerate(out):
        day["day"] = f"Day {idx + 1}"

    return out, _violations(out) == 0


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

    # Route every emitted exercise through the canonical planner helper
    # so AI-regenerated dicts share the same schema as deterministic
    # plans (setScheme, targetWeightLbs, weightRecommendation* fields,
    # full internal metadata). perf_profiles=None here — the caller
    # in `routers/ai/plans.py` re-runs `_stamp_load_metadata` with
    # real profiles after accepting the regen, so load fields end up
    # populated just like the deterministic pipeline.
    try:
        from .planner import build_planner_exercise
        from .prescriptions import Prescription
    except Exception as exc:
        print(f"[plan_ai_regenerate] helper import failed: {exc}")
        return None

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
            # Role heuristic preserved: index 0 → primary, 1-2 → secondary,
            # 3+ → isolation. Passed through as `role` so build_planner_exercise
            # stamps it on `_role`.
            role = "primary" if ei == 0 else ("secondary" if ei < 3 else "isolation")
            pres = Prescription(
                sets=int(e.get("sets") or 3),
                reps=str(e.get("reps") or "8-12"),
                rest_seconds=int(e.get("rest_seconds") or 90),
                rir_target=2.0,
            )
            # Use the canonical seed row (not the AI-echoed name) so all
            # muscle/equipment/image fields match our seed exactly.
            seed_with_name = dict(seed)
            seed_with_name["name"] = name
            out_ex = build_planner_exercise(
                seed_with_name,
                prescription=pres,
                slot_label=None,
                role=role,
                archetype_value=None,
                training_type=(seed.get("training_type") or None),
                goal_bucket=goal,
                experience=experience,
                perf_profiles=None,
                all_exercises_by_slug=None,
            )
            # Preserve the AI-provided equipment label if set and non-empty;
            # build_planner_exercise computes one from the seed row, but
            # the prompt asked the AI to echo the catalog's equipment
            # string, so prefer that when present.
            ai_equipment = str(e.get("equipment") or "").strip()
            if ai_equipment:
                out_ex["equipment"] = ai_equipment
            # Mark this exercise as AI-regenerated for downstream debug.
            out_ex["_ai_regenerated"] = True
            exs_out.append(out_ex)
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

    # ── Post-assembly adjacency repair ─────────────────────────────
    # The deterministic planner sweeps adjacent same-family days
    # through `_repair_adjacent_duplicates`; this path bypasses it.
    # Swap day dicts in place (preserving their exercises) to break
    # any Push→Push, Legs→Legs, or Pull→Upper (coarse bucket)
    # adjacency the AI emitted. If the repair can't resolve all
    # violations (structurally bad AI output), bail out so the
    # caller keeps the deterministic plan — logged as ERROR so prod
    # telemetry picks it up.
    ai_focus_sequence = [d.get("focus") or "" for d in valid_days]
    valid_days, adjacency_ok = _repair_focus_adjacency(valid_days)
    if not adjacency_ok:
        logger.error(
            "[plan_ai_regenerate] adjacency repair FAILED — falling back to "
            "deterministic plan. AI focus sequence: %r; post-repair: %r",
            ai_focus_sequence,
            [d.get("focus") or "" for d in valid_days],
        )
        return None
    if ai_focus_sequence != [d.get("focus") or "" for d in valid_days]:
        logger.warning(
            "[plan_ai_regenerate] adjacency repair reshuffled days. "
            "AI focus sequence: %r; repaired: %r",
            ai_focus_sequence,
            [d.get("focus") or "" for d in valid_days],
        )

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
