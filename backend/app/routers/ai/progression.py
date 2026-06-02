from __future__ import annotations

import json
import logging
import math
import os
from typing import Any

import openai
from openai import OpenAI
from fastapi import BackgroundTasks, HTTPException, Depends
from sqlalchemy import func
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import Exercise, User

from .router import router
from .models import WeightRecommendRequest, WorkoutSummaryRequest, WarmupRequest, PreSetRecommendRequest, ValidateFoodMacrosRequest
from .utils import (
    get_openai_api_key, model_chat,
    _build_chat_kwargs, _chat_create, _extract_json, _log_openai_error,
    progression_engine,
    map_goal_type, map_feedback, infer_exercise_category, parse_target_reps,
    map_progression_priority, map_workout_focus, map_phase,
    map_progression_pace, map_experience_level, map_recovery_level,
    SCHEMA_WORKOUT_SUMMARY,
)
from app.workout_progression import (
    ExerciseCategory, ExercisePrescription, PlannedSet, ReadinessInput,
    SetResult, SetType, UserTrainingProfile, WorkoutContext,
)
from app.services.workout.performance import (
    build_performance_profile,
    merge_strength_anchor_profiles,
)
from app.services.workout.recommendation import (
    apply_fatigue_override,
    recommend_starting_weight,
)
from app.services.workout.exercise_metadata import (
    resolve_seed_exercise_slug,
    set_programming_exercise_metadata,
)
from app.services.workout.recommendation_ai_safety import prepare_ai_safety_review
from app.seed_exercises_data import SEED_EXERCISES  # noqa: F401  (used inside handler)


logger = logging.getLogger(__name__)

LIVE_RECOMMENDATION_VERSION = "live_recommendation.v1"
LIVE_RECOMMENDATION_ALGORITHM_SOURCE = "deterministic_progression"
_MAX_LIVE_SET_SCHEME_ROWS = 12


def _safe_positive_int(value: Any, fallback: int, *, max_value: int = _MAX_LIVE_SET_SCHEME_ROWS) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError):
        return fallback
    if out < 1:
        return fallback
    return min(out, max_value)


def _safe_target_reps(value: Any, fallback: str | None) -> str | None:
    raw = fallback if value is None else value
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or len(text) > 40:
        return fallback
    return text


def _recommendation_data_source(source: Any, *, has_session_sets: bool = False) -> str:
    if has_session_sets:
        return "session_state"
    mapping = {
        "exact_history": "exact_exercise_history",
        "strength_anchor": "exact_exercise_history",
        "last_session_best": "exact_exercise_history",
        "all_time_best": "exact_exercise_history",
        "substitution_group": "substitution_group",
        "movement_pattern": "movement_pattern",
        "muscle_bucket": "muscle_equipment_bucket",
        "planned_target": "plan_snapshot",
        "default": "default",
        "bodyweight": "default",
    }
    return mapping.get(str(source or "").strip(), "default")


def _with_recommendation_metadata(meta: dict | None, *, data_source: str | None = None) -> dict | None:
    if meta is None:
        return None
    source = meta.get("source")
    return {
        **meta,
        "algorithmSource": LIVE_RECOMMENDATION_ALGORITHM_SOURCE,
        "dataSource": data_source or _recommendation_data_source(source),
    }


def _recent_history_rows_from_live_request(body: WeightRecommendRequest) -> list[dict]:
    rows: list[dict] = []
    if body.lastSessionBestWeightLbs and body.lastSessionBestWeightLbs > 0:
        rows.append({
            "weightLbs": float(body.lastSessionBestWeightLbs),
            "reps": int(body.lastSessionBestReps or 0) or None,
            "date": body.lastSessionBestDate,
        })
    if body.allTimeBestWeightLbs and body.allTimeBestWeightLbs > 0:
        rows.append({
            "weightLbs": float(body.allTimeBestWeightLbs),
            "reps": int(body.allTimeBestReps or 0) or None,
            "date": body.allTimeBestDate,
        })
    return rows


def _ai_safety_payload_for_next_set(
    *,
    body: WeightRecommendRequest,
    exercise_meta: dict,
    numeric_load: bool,
    recommended_weight_lbs: float,
    recommended_reps: int | str,
    data_source: str | None,
    confidence: Any,
    action: str | None,
    reason_tags: list[str] | None = None,
) -> dict:
    return {
        "kind": "next_set",
        "exercise": {
            "name": body.exerciseName,
            "slug": body.exerciseSlug or exercise_meta.get("slug"),
            "equipment": body.equipment or exercise_meta.get("equipment_bucket"),
            "primaryMuscle": body.primaryMuscle or exercise_meta.get("primary_muscle"),
            "loadSemantics": exercise_meta.get("load_semantics"),
            "numericLoad": bool(numeric_load),
        },
        "recommendation": {
            "weightLbs": recommended_weight_lbs,
            "reps": str(recommended_reps),
            "dataSource": data_source,
            "confidence": confidence,
            "action": action,
        },
        "plan": {
            "targetWeightLbs": body.plannedTargetWeightLbs,
            "targetReps": body.targetReps,
        },
        "currentSessionSets": [
            {"weightLbs": s.weightLbs, "reps": s.reps, "rir": s.rir}
            for s in (body.lastSets or [])[-4:]
        ],
        "lastSessionSets": _recent_history_rows_from_live_request(body),
        "recentHistory": _recent_history_rows_from_live_request(body),
        "reasonTags": reason_tags or [],
    }


def _ai_safety_payload_for_pre_set(
    *,
    body: PreSetRecommendRequest,
    exercise_meta: dict,
    numeric_load: bool,
    recommended_weight_lbs: float | None,
    recommended_reps: str,
    data_source: str | None,
    confidence: Any,
    action: str | None,
    planned_weight_lbs: float | None,
    last_session_sets: list[dict] | None,
    prior_sets: list[dict] | None,
    reason_tags: list[str] | None = None,
) -> dict:
    return {
        "kind": "pre_set",
        "exercise": {
            "name": body.exerciseName,
            "slug": body.exerciseSlug or exercise_meta.get("slug"),
            "equipment": body.equipment or exercise_meta.get("equipment_bucket"),
            "primaryMuscle": body.primaryMuscle or exercise_meta.get("primary_muscle"),
            "loadSemantics": exercise_meta.get("load_semantics"),
            "numericLoad": bool(numeric_load),
        },
        "recommendation": {
            "weightLbs": recommended_weight_lbs,
            "reps": recommended_reps,
            "dataSource": data_source,
            "confidence": confidence,
            "action": action,
        },
        "plan": {
            "targetWeightLbs": planned_weight_lbs,
            "targetReps": None,
        },
        "currentSessionSets": prior_sets or [],
        "lastSessionSets": last_session_sets or [],
        "recentHistory": last_session_sets or [],
        "reasonTags": reason_tags or [],
    }


def _live_recommendation_trace(
    *,
    set_intent: Any = None,
    previous_set_classification: Any = None,
    target_rep_range: Any = None,
    prior_weight: Any = None,
    recommended_weight: Any = None,
    recommended_reps: Any = None,
    adjustment_reason: Any = None,
    fatigue_applied: bool = False,
    rir_used: Any = None,
    fallback_used: bool = False,
) -> dict:
    return {
        "recommendationVersion": LIVE_RECOMMENDATION_VERSION,
        "setIntent": set_intent,
        "previousSetClassification": previous_set_classification,
        "targetRepRange": target_rep_range,
        "priorWeight": prior_weight,
        "recommendedWeight": recommended_weight,
        "recommendedReps": recommended_reps,
        "adjustmentReason": adjustment_reason,
        "fatigueApplied": bool(fatigue_applied),
        "rirUsed": rir_used,
        "fallbackUsed": bool(fallback_used),
    }


def _reason_tags_for_live_response(
    *,
    action: str | None,
    debug: dict | None,
    suspicion_reasons: list[str] | None,
    fatigue_applied: bool,
) -> list[str]:
    tags: list[str] = []
    classification = (debug or {}).get("classification")
    if classification == "underloaded_or_strong":
        tags.append("progressive_overload")
    elif classification == "too_heavy_or_fatigued":
        tags.append("undershot_reps")
    elif classification == "on_target":
        tags.append("hit_range")
    if action == "increase":
        tags.append("progressive_overload")
    elif action == "decrease":
        tags.append("deload_trigger")
    if fatigue_applied or (debug or {}).get("fatigue_drop_reps"):
        tags.append("high_fatigue")
    for reason in suspicion_reasons or []:
        text = str(reason)
        if "overshoot" in text:
            tags.append("overshot_reps")
        elif "undershoot" in text:
            tags.append("undershot_reps")
        elif "pain" in text:
            tags.append("feel_pain")
    seen: set[str] = set()
    return [t for t in tags if not (t in seen or seen.add(t))]


def _rep_adjust_legacy_anchor(
    *,
    raw_weight: float,
    raw_reps: int | float | None,
    target_reps: str | None,
) -> float:
    """Convert a "what the user lifted last time" anchor to a working
    weight for today's prescribed rep range.

    Without this transform, a heavy 225 × 5 last week becomes the
    starting recommendation for a 10–15 rep volume session — rep-aware
    %1RM scaling is the difference between "today felt right" and
    "I bailed at rep 7."

    Path:
        anchor_weight × (1 + raw_reps/30)   → e1RM (Epley)
        e1RM × _RPE_PCT[mid(target_reps)]   → today's working weight

    When `raw_reps` is missing (legacy clients that only sent the raw
    weight), we assume a moderate 8-rep working set so the conversion
    still happens but the anchor confidence stays modest.
    """
    if raw_weight <= 0:
        return 0.0
    from app.services.workout.recommendation import _RPE_PCT, _mid_reps, _round_to_plate
    perf_reps_raw = raw_reps if raw_reps is not None else 8
    try:
        perf_reps = max(1, min(15, int(perf_reps_raw)))
    except (TypeError, ValueError):
        perf_reps = 8
    e1rm = raw_weight * (1 + perf_reps / 30.0)
    target_mid = max(1, min(20, _mid_reps(target_reps)))
    pct = _RPE_PCT.get(target_mid, 0.75)
    return _round_to_plate(e1rm * pct, increment=2.5)


def _history_row_performed_on(row: dict | None):
    if not isinstance(row, dict):
        return None
    for key in (
        "performedOn",
        "performed_on",
        "sessionDate",
        "session_date",
        "completedAt",
        "completed_at",
        "date",
    ):
        value = row.get(key)
        if value:
            return value
    return None


def _apply_reacclimation_if_stale(
    weight_lbs: float,
    performed_on,
    *,
    increment_lbs: float,
) -> tuple[float, object | None]:
    from app.services.workout.recency import recency_adjustment
    from app.services.workout.set_programming import round_to_increment

    adj = recency_adjustment(performed_on)
    if not adj.is_stale or weight_lbs <= 0:
        return weight_lbs, None
    increment = increment_lbs if increment_lbs and increment_lbs > 0 else 2.5
    return round_to_increment(weight_lbs * adj.load_multiplier, increment), adj


def _resolve_exercise_slug(db: Session | None, exercise_name: str, exercise_slug: str | None) -> str | None:
    """Best-effort canonical slug resolution for the recommend-weight
    path. Prefers the client-provided slug, falls back to a
    case-insensitive `Exercise.name` lookup. Returns None when we can't
    find a seed match — downstream code falls back to legacy anchors."""
    if exercise_slug:
        return exercise_slug
    seed_slug = resolve_seed_exercise_slug(exercise_name, None)
    if seed_slug:
        return seed_slug
    if not exercise_name or db is None:
        return None
    row = db.exec(select(Exercise).where(Exercise.name.ilike(exercise_name))).first()
    return row.slug if row else None


def _primary_muscle_for(
    db: Session | None, exercise_name: str, exercise_slug: str | None
) -> str | None:
    """Best-effort primary-muscle lookup for the fatigue overlay.

    Tries (in order): the client-provided slug against the seed, the
    exercise name against the seed, and finally the Exercise DB row.
    Returns None when we can't find a muscle — the fatigue override
    silently skips in that case.
    """
    try:
        from app.seed_exercises_data import SEED_EXERCISES
        seed_row = None
        if exercise_slug:
            seed_row = next(
                (ex for ex in SEED_EXERCISES if ex.get("slug") == exercise_slug),
                None,
            )
        if seed_row is None and exercise_name:
            lname = exercise_name.strip().lower()
            seed_row = next(
                (
                    ex for ex in SEED_EXERCISES
                    if (ex.get("name") or "").strip().lower() == lname
                ),
                None,
            )
        if seed_row is not None:
            pm = seed_row.get("primary_muscle")
            if hasattr(pm, "value"):
                return str(pm.value)
            if pm:
                return str(pm)
    except Exception:
        logger.exception(
            "[recommend-weight] seed primary_muscle lookup failed (non-fatal)"
        )

    if not exercise_name or db is None:
        return None
    try:
        row = db.exec(select(Exercise).where(Exercise.name.ilike(exercise_name))).first()
        if row and row.primary_muscle is not None:
            pm = row.primary_muscle
            return str(pm.value) if hasattr(pm, "value") else str(pm)
    except Exception:
        logger.exception(
            "[recommend-weight] DB primary_muscle lookup failed (non-fatal)"
        )
    return None


def _set_programming_exercise_metadata(
    db: Session | None,
    exercise_name: str,
    exercise_slug: str | None = None,
    equipment: str | None = None,
    primary_muscle: str | None = None,
) -> dict:
    return set_programming_exercise_metadata(
        db,
        exercise_name,
        exercise_slug,
        equipment,
        primary_muscle,
    )


def _target_reps_hint(raw: Any, fallback: str | None) -> str | None:
    if not isinstance(raw, dict):
        return fallback
    value = raw.get("targetReps") or raw.get("target_reps") or fallback
    return _safe_target_reps(value, fallback)


def _live_scheme_set_type(raw_type: Any, target_reps: str | None) -> SetType:
    text = str(raw_type or "").strip().lower()
    if text in ("heavy_top", "top_set"):
        return SetType.TOP_SET
    if text == "backoff":
        return SetType.BACKOFF
    if text == "warmup":
        return SetType.WARMUP
    if text in ("straight", "volume", "working", "technique"):
        return SetType.STRAIGHT
    if target_reps:
        try:
            hi = int(str(target_reps).split("-", 1)[-1].strip())
            if hi <= 6:
                return SetType.TOP_SET
        except (ValueError, TypeError):
            pass
    return SetType.STRAIGHT


def _planned_sets_from_live_scheme(
    *,
    raw_scheme: list[dict] | None,
    planned_set_count: int,
    plan_rep_target: str | None,
    fallback_set_type: SetType,
) -> list[PlannedSet]:
    safe_count = _safe_positive_int(planned_set_count, 1)
    rows = [
        row for row in (raw_scheme if isinstance(raw_scheme, list) else [])
        if isinstance(row, dict)
    ][:_MAX_LIVE_SET_SCHEME_ROWS * 2]
    planned: list[PlannedSet] = []
    seen_numbers: set[int] = set()
    for idx, row in enumerate(rows):
        fallback_number = min(idx + 1, safe_count)
        set_number = _safe_positive_int(
            row.get("setNumber") or row.get("set_number"),
            fallback_number,
            max_value=safe_count,
        )
        if set_number in seen_numbers:
            continue
        target_reps = _target_reps_hint(row, plan_rep_target)
        seen_numbers.add(set_number)
        planned.append(
            PlannedSet(
                set_number=set_number,
                set_type=_live_scheme_set_type(row.get("setType") or row.get("set_type"), target_reps),
                target_reps_override=target_reps,
            )
        )
        if len(planned) >= safe_count:
            break

    if not planned:
        planned = [
            PlannedSet(
                set_number=idx + 1,
                set_type=fallback_set_type,
                target_reps_override=plan_rep_target,
            )
            for idx in range(safe_count)
        ]

    existing_numbers = {p.set_number for p in planned}
    for idx in range(safe_count):
        set_number = idx + 1
        if set_number in existing_numbers:
            continue
        planned.append(
            PlannedSet(
                set_number=set_number,
                set_type=fallback_set_type,
                target_reps_override=plan_rep_target,
            )
        )

    return sorted(planned, key=lambda s: s.set_number)


def _positive_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _finite_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _equipment_label_for_recommendation(equipment: Any, exercise_meta: dict | None) -> str | None:
    explicit = str(equipment or "").strip()
    if explicit:
        return explicit
    if not isinstance(exercise_meta, dict):
        return None
    raw_equipment = exercise_meta.get("equipment")
    if isinstance(raw_equipment, list):
        slugs: list[str] = []
        for item in raw_equipment:
            if isinstance(item, dict):
                value = item.get("slug") or item.get("name")
            else:
                value = item
            if value:
                slugs.append(str(value))
        if slugs:
            return ", ".join(slugs)
    bucket = str(exercise_meta.get("equipment_bucket") or "").strip()
    return bucket or None


def _equipment_settings_for_user(db: Session | None, current_user: Any) -> dict | None:
    user_id = getattr(current_user, "id", None)
    if db is None or user_id is None:
        return None
    try:
        from app.models import UserPreferences as _UserPreferences
        prefs = db.exec(
            select(_UserPreferences).where(_UserPreferences.user_id == user_id)
        ).first()
        return getattr(prefs, "equipment_settings", None) if prefs else None
    except Exception:
        return None


def _format_load_lbs(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def _loadability_adjusted_text(original: float, snapped: float) -> str:
    return (
        f"Use {_format_load_lbs(snapped)} lb — adjusted from "
        f"{_format_load_lbs(original)} lb to match what you can load."
    )


def _snap_recommendation_load(
    weight_lbs: float | None,
    *,
    equipment_label: str | None,
    equipment_settings: dict | None,
    fallback_increment: float,
) -> float | None:
    if weight_lbs is None or weight_lbs <= 0:
        return weight_lbs
    try:
        from app.services.workout.load_equipment import snap_load_lbs
        snapped = snap_load_lbs(
            weight_lbs,
            equipment_label,
            equipment_settings,
            fallback_increment=fallback_increment,
        )
        return float(snapped) if snapped is not None else weight_lbs
    except Exception:
        return weight_lbs


def _scheme_row_by_number(raw_scheme: list[dict] | None, set_number: int | None) -> dict | None:
    if set_number is None:
        return None
    rows = raw_scheme if isinstance(raw_scheme, list) else []
    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        raw_number = row.get("setNumber") or row.get("set_number") or idx + 1
        try:
            if int(raw_number) == int(set_number):
                return row
        except (TypeError, ValueError):
            continue
    return None


def _planned_backoff_transition_weight(
    raw_scheme: list[dict] | None,
    *,
    completed_set_number: int | None,
    next_set_number: int | None,
    completed_actual_weight_lbs: float | None = None,
    increment_lbs: float | None = None,
) -> float | None:
    current = _scheme_row_by_number(raw_scheme, completed_set_number)
    upcoming = _scheme_row_by_number(raw_scheme, next_set_number)
    if not current or not upcoming:
        return None
    current_type = str(current.get("setType") or current.get("set_type") or "").lower()
    next_type = str(upcoming.get("setType") or upcoming.get("set_type") or "").lower()
    if current_type not in ("heavy_top", "top_set") or next_type not in ("backoff", "volume"):
        return None
    upcoming_weight = _positive_float(upcoming.get("targetWeightLbs") or upcoming.get("target_weight_lbs"))
    if upcoming_weight is None:
        return None
    actual_weight = _positive_float(completed_actual_weight_lbs)
    if actual_weight is not None:
        current_target = _positive_float(current.get("targetWeightLbs") or current.get("target_weight_lbs"))
        if upcoming_weight >= actual_weight:
            ratio = 0.90
            if current_target is not None and upcoming_weight < current_target:
                ratio = upcoming_weight / current_target
            ratio = min(0.90, max(0.75, ratio))
            inc = _positive_float(increment_lbs) or 5.0
            from app.services.workout.set_programming import round_to_increment
            adjusted = round_to_increment(actual_weight * ratio, inc)
            if adjusted >= actual_weight and inc > 0:
                adjusted = round_to_increment(actual_weight - inc, inc)
            return adjusted if adjusted > 0 and adjusted < actual_weight else None
        if current_target is not None:
            allowed_drift = max(15.0, current_target * 0.20)
            if abs(actual_weight - current_target) > allowed_drift:
                return None
        if upcoming_weight < actual_weight * 0.75:
            return None
    return upcoming_weight


def _set_programming_set_type(raw_type: Any, target_reps: str | None) -> str:
    text = str(raw_type or "").strip().lower()
    if text in ("heavy_top", "top_set"):
        return "heavy_top"
    if text in ("backoff", "volume", "technique", "warmup"):
        return text
    if target_reps:
        try:
            hi = int(str(target_reps).split("-", 1)[-1].strip())
            if hi <= 6:
                return "heavy_top"
        except (ValueError, TypeError):
            pass
    return "volume"


def _set_programming_progression_mode(raw_mode: Any, set_type: str) -> str:
    text = str(raw_mode or "").strip().lower()
    if text in ("load_first", "reps_first", "fixed_skill"):
        return text
    if set_type == "heavy_top":
        return "load_first"
    if set_type in ("technique", "warmup"):
        return "fixed_skill"
    return "reps_first"


def _review_planned_set_from_live_scheme(
    raw_scheme: list[dict] | None,
    *,
    completed_set_number: int,
    fallback_target_reps: str,
    fallback_weight_lbs: float | None,
):
    from app.services.workout.set_programming import PlannedSet as SPPlannedSet

    row = _scheme_row_by_number(raw_scheme, completed_set_number) or {}
    target_reps = _target_reps_hint(row, fallback_target_reps) or fallback_target_reps
    set_type = _set_programming_set_type(row.get("setType") or row.get("set_type"), target_reps)
    progression_mode = _set_programming_progression_mode(
        row.get("progressionMode") or row.get("progression_mode"),
        set_type,
    )
    target_rir = _finite_float(row.get("targetRir") if "targetRir" in row else row.get("target_rir"))
    if target_rir is None:
        target_rir = 2.0
    target_weight = _positive_float(
        row.get("targetWeightLbs") if "targetWeightLbs" in row else row.get("target_weight_lbs")
    )
    if target_weight is not None and target_weight > 2000:
        target_weight = None
    if target_weight is None:
        target_weight = fallback_weight_lbs

    return SPPlannedSet(
        set_number=completed_set_number,
        set_type=set_type,
        target_reps=target_reps,
        target_rir=float(max(0.0, min(5.0, target_rir))),
        target_weight_lbs=target_weight,
        progression_mode=progression_mode,
    )


def _should_use_reviewed_load_increase(
    *,
    reviewed: Any,
    planned_set: Any,
    actual_reps: int,
    actual_rir: float | None,
    feel: str | None,
) -> bool:
    """Let the deterministic set-programming reviewer override the older
    progression engine only when the just-logged set was meaningfully
    underloaded. This keeps normal heavy-top → backoff transitions intact
    while preventing high-RIR overshoots from being crushed by stale
    planned backoff weights."""
    if reviewed is None or reviewed.action != "increase_load":
        return False
    if reviewed.next_set_weight_lbs is None:
        return False
    if str(feel or "").strip().lower() in ("pain", "form_breakdown", "form breakdown"):
        return False
    if any("big overshoot" in str(r) for r in reviewed.suspicion_reasons):
        return True
    if actual_rir is None:
        return False
    try:
        from app.services.workout.set_programming import parse_rep_range
        rep_range = parse_rep_range(planned_set.target_reps)
    except Exception:
        rep_range = None
    if rep_range is None:
        return False
    _lo, hi = rep_range
    return (
        actual_reps >= hi + 2
        and actual_rir >= float(planned_set.target_rir) + 1.0
    )


# Deprecated compatibility route. Canonical path:
# `POST /recommendations/next-set`.
@router.post("/recommend-weight")
def recommend_weight(
    body: WeightRecommendRequest,
    current_user: User = Depends(require_pro_feature("Advanced in-workout progression guidance")),
    db: Session = Depends(get_session),
    background_tasks: BackgroundTasks = None,
):
    """Deterministic next-set recommendation based on recent performance and feedback.

    Anchor priority for the first-set weight (set 1 of the session, when
    no sets have been logged yet):

        1. Current-session completed sets (handled by the progression
           engine below — if `body.lastSets` is non-empty, that's the
           authoritative anchor).
        2. Exact exercise performance profile (live query against the
           user's recent completed sessions in this DB).
        3. Transferred estimate from a similar exercise
           (substitution_group → movement_pattern → muscle_bucket).
        4. `lastSessionBestWeightLbs` (client-provided exact-history fallback).
        5. `allTimeBestWeightLbs` (client-provided fallback).
        6. `plannedTargetWeightLbs` from the plan snapshot.
        7. Category default.

    Each step past (1) also populates a `recommendation` field on the
    response so the client can show the user *why* a weight was picked."""
    try:
        exercise_meta = _set_programming_exercise_metadata(
            db,
            body.exerciseName,
            body.exerciseSlug,
            body.equipment,
            body.primaryMuscle,
        )
        from app.services.workout.set_programming import load_increment_for
        metadata_increment_lbs = load_increment_for(exercise_meta)

        # Bodyweight gate: exercises performed with bodyweight (no added load)
        # never get a weight recommendation. Short-circuit before any tier logic.
        # The client also guards via shouldHideWeight(), but this prevents
        # non-zero weights from leaking through edge cases (e.g. historical
        # data with weight for an exercise the user is now doing unloaded).
        if (
            (body.equipment or "").strip().lower() in ("bodyweight", "none", "bw")
            or metadata_increment_lbs <= 0
        ):
            trace = _live_recommendation_trace(
                set_intent="bodyweight",
                target_rep_range=body.targetReps,
                prior_weight=0.0,
                recommended_weight=0.0,
                recommended_reps=0,
                adjustment_reason="bodyweight_no_load",
            )
            return {
                "weightLbs": 0.0, "reps": 0,
                "tip": "", "action": "continue", "repRange": None,
                "debug": {}, "recommendation": None, "awaitingFeel": False,
                "source": "bodyweight", "suspicionReasons": [], "fatigue_override": False,
                "algorithmSource": LIVE_RECOMMENDATION_ALGORITHM_SOURCE,
                "dataSource": "default",
                "confidence": None,
                "reasonTags": [],
                "trace": trace,
            }

        planned_set_count = _safe_positive_int(
            body.targetSets if body.targetSets and body.targetSets > 0 else max(1, body.nextSetNumber),
            max(1, body.nextSetNumber),
        )
        # Forward the plan's per-exercise rep target onto every planned set
        # so the progression engine honors the plan's intent instead of
        # defaulting to goal-based ranges. Also promote heavy ranges to
        # TOP_SET so RIR thresholds match a heavy-top prescription.
        plan_rep_target = (body.targetReps or "").strip() or None
        inferred_set_type = SetType.STRAIGHT
        if plan_rep_target:
            try:
                parts = plan_rep_target.split("-", 1)
                hi = int(parts[-1])
                if hi <= 6:
                    inferred_set_type = SetType.TOP_SET
            except ValueError:
                pass
        planned_sets = _planned_sets_from_live_scheme(
            raw_scheme=body.setScheme,
            planned_set_count=planned_set_count,
            plan_rep_target=plan_rep_target,
            fallback_set_type=inferred_set_type,
        )

        sets_completed = [
            SetResult(
                set_number=s.setNumber,
                weight_lbs=s.weightLbs,
                reps=s.reps,
                rir=s.rir,
                feedback=map_feedback(s.feedback),
            )
            for s in body.lastSets
        ]
        last_weight = sets_completed[-1].weight_lbs if sets_completed else None

        # Fetch the user's current per-muscle fatigue snapshot once so
        # the fatigue overlay (below) can downshift the first-set anchor
        # when the target muscle is elevated. Non-fatal — on any error
        # we just skip the override. The downstream in-workout path
        # already tolerates a None snapshot.
        muscle_fatigue_dict: dict | None = None
        if db is not None:
            try:
                from app.services.workout.history import (
                    get_recent_completions_for_fatigue,
                )
                from app.services.workout.activity_impact import (
                    compute_rolling_fatigue,
                )
                _completions = get_recent_completions_for_fatigue(current_user.id, db)
                if _completions:
                    _snap = compute_rolling_fatigue(_completions)
                    muscle_fatigue_dict = _snap.muscle_fatigue.to_dict()
            except Exception:
                logger.exception(
                    "[recommend-weight] fatigue snapshot lookup failed (non-fatal)"
                )
                muscle_fatigue_dict = None

        goal_type  = map_goal_type(body.goal)
        profile    = UserTrainingProfile(
            primary_goal=goal_type,
            experience_level=map_experience_level(body.experienceLevel),
            recovery_level=map_recovery_level(body.recoveryLevel),
            progression_pace=map_progression_pace(body.progressionPace),
        )
        workout    = WorkoutContext(
            workout_name="Current Workout",
            focus=map_workout_focus(body.workoutFocus),
            phase=map_phase(body.phase),
            week_number=max(1, body.weekNumber or 1),
        )
        ex_category = infer_exercise_category(body.exerciseName)
        equipment_settings = _equipment_settings_for_user(db, current_user)
        equipment_label = _equipment_label_for_recommendation(body.equipment, exercise_meta)
        try:
            from app.services.workout.load_equipment import load_increment_lbs, snap_load_lbs
            fallback_increment = (
                metadata_increment_lbs
                if metadata_increment_lbs > 0
                else (
                    float(body.incrementLbs)
                    if body.incrementLbs and body.incrementLbs > 0
                    else (2.5 if "dumbbell" in (body.equipment or "").lower() else 5.0)
                )
            )
            effective_increment_lbs = load_increment_lbs(
                equipment_label,
                equipment_settings,
                fallback=fallback_increment,
            )
        except Exception:
            snap_load_lbs = None  # type: ignore[assignment]
            effective_increment_lbs = max(1.0, body.incrementLbs or 5.0)
        # Layered anchor pipeline for the first set of the session.
        # `recommendation_meta` carries the source + confidence + reason
        # back to the client so the UI can explain the pick.
        #
        # Priority change (2026-05-08): the rep-aware history estimator
        # runs FIRST. Previously we trusted `plannedTargetWeightLbs`
        # blindly — but that target is computed once when the plan is
        # generated, against THAT WEEK's prescribed rep range. When the
        # rep range shifts between sessions (heavy 3–5 → volume 10–15),
        # last week's 225 lb planned target gets handed back to the user
        # unchanged for the new range. The fix: convert through e1RM via
        # `recommend_starting_weight`, which applies the right %1RM for
        # the current target_reps. We fall back to `plannedTargetWeightLbs`
        # only when there's no exact-history profile to anchor from.
        recommendation_meta: dict | None = None
        if last_weight is None:
            # Build the user's exercise profile up-front so both tiers
            # can read from it.
            slug = _resolve_exercise_slug(db, body.exerciseName, body.exerciseSlug)
            target_ex: dict | None = None
            profiles: dict = {}
            if slug is not None:
                by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
                target_ex = by_slug.get(slug)
                if db is not None:
                    try:
                        profiles = merge_strength_anchor_profiles(
                            current_user.id,
                            db,
                            build_performance_profile(current_user.id, db, window_days=90),
                        )
                    except Exception as e:
                        print(f"[recommend-weight] profile build failed (non-fatal): {e}")
                        profiles = {}
                else:
                    profiles = {}

                if target_ex is not None:
                    rec_anchor = recommend_starting_weight(
                        target_ex,
                        profiles=profiles,
                        all_exercises_by_slug=by_slug,
                        target_reps=body.targetReps,
                        experience=(body.experienceLevel or "intermediate"),
                    )
                    # Only accept the recommendation if it comes from
                    # real user data. `default` means we couldn't
                    # find anything — fall through to the
                    # client-provided anchors below.
                    if rec_anchor.source != "default" and rec_anchor.weight_lbs > 0:
                        last_weight = rec_anchor.weight_lbs
                        recommendation_meta = {
                            "source": rec_anchor.source,
                            "confidence": rec_anchor.confidence,
                            "reason": rec_anchor.reason,
                        }

            # Tier 5 — client-provided last-session best. Apply the same
            # rep-aware conversion: convert that weight back to an e1RM
            # via the reps it was performed at, then forward to a
            # working weight at the target reps. Without this, a 5-rep
            # PR last session gets handed back unchanged for a 10–15
            # rep target. This beats the plan snapshot because it is
            # fresher exact-exercise history from the user's log.
            if last_weight is None and body.lastSessionBestWeightLbs and body.lastSessionBestWeightLbs > 0:
                last_weight = _rep_adjust_legacy_anchor(
                    raw_weight=float(body.lastSessionBestWeightLbs),
                    raw_reps=getattr(body, "lastSessionBestReps", None),
                    target_reps=body.targetReps,
                )
                last_weight, recency_adj = _apply_reacclimation_if_stale(
                    last_weight,
                    body.lastSessionBestDate,
                    increment_lbs=effective_increment_lbs,
                )
                reason = "Based on your most recent session's top set, adjusted for today's rep range"
                confidence = 0.60
                if recency_adj is not None:
                    from app.services.workout.recency import adjust_confidence_for_recency
                    confidence = adjust_confidence_for_recency(confidence, recency_adj)
                    reason = f"{reason}; {recency_adj.reason}"
                recommendation_meta = {
                    "source": "last_session_best",
                    "confidence": confidence,
                    "reason": reason,
                }
            # Tier 6 — all-time best, same rep-aware adjustment.
            if last_weight is None and body.allTimeBestWeightLbs and body.allTimeBestWeightLbs > 0:
                last_weight = _rep_adjust_legacy_anchor(
                    raw_weight=float(body.allTimeBestWeightLbs),
                    raw_reps=getattr(body, "allTimeBestReps", None),
                    target_reps=body.targetReps,
                )
                last_weight, recency_adj = _apply_reacclimation_if_stale(
                    last_weight,
                    body.allTimeBestDate,
                    increment_lbs=effective_increment_lbs,
                )
                reason = "Based on your all-time best set, adjusted for today's rep range"
                confidence = 0.45
                if recency_adj is not None:
                    from app.services.workout.recency import adjust_confidence_for_recency
                    confidence = adjust_confidence_for_recency(confidence, recency_adj)
                    reason = f"{reason}; {recency_adj.reason}"
                recommendation_meta = {
                    "source": "all_time_best",
                    "confidence": confidence,
                    "reason": reason,
                }
            # Planner-propagated target — used only when there's no
            # exact-history anchor. Plan snapshots can be stale for a
            # 7-day PlanWeek, so they must not override a completed set.
            if last_weight is None and body.plannedTargetWeightLbs and body.plannedTargetWeightLbs > 0:
                last_weight = float(body.plannedTargetWeightLbs)
                recommendation_meta = {
                    "source": "planned_target",
                    "confidence": 0.55,
                    "reason": "Using the target your plan set for this session",
                }
            # Tier 7 — category default.
            if last_weight is None:
                last_weight = {
                    ExerciseCategory.COMPOUND: 65.0,
                    ExerciseCategory.ISOLATION: 20.0,
                    ExerciseCategory.MACHINE: 80.0,
                    ExerciseCategory.BODYWEIGHT: 0.0,
                }.get(ex_category, 45.0)
                recommendation_meta = {
                    "source": "default",
                    "confidence": 0.15,
                    "reason": "Starting weight for this movement — adjust after your first set",
                }

        # ── Fatigue overlay ────────────────────────────────────────
        # Only meaningful for the FIRST set of the session (no sets
        # logged yet). Mid-workout, the progression engine is already
        # reacting to what just happened — a fatigue downshift on top
        # would double-count. `sets_completed` being empty is the
        # same guard we use for every tier-resolution branch above.
        fatigue_override_flag = False
        if not sets_completed and last_weight is not None and last_weight > 0:
            primary_muscle_for_fatigue = _primary_muscle_for(
                db, body.exerciseName, body.exerciseSlug
            )
            if primary_muscle_for_fatigue and muscle_fatigue_dict:
                base_conf = (
                    (recommendation_meta or {}).get("confidence")
                    if recommendation_meta else None
                )
                base_reason = (
                    (recommendation_meta or {}).get("reason")
                    if recommendation_meta else ""
                )
                adj = apply_fatigue_override(
                    weight_lbs=float(last_weight),
                    base_confidence=base_conf if base_conf is not None else 0.15,
                    base_reason=base_reason or "",
                    primary_muscle=primary_muscle_for_fatigue,
                    muscle_fatigue=muscle_fatigue_dict,
                    muscle_label=primary_muscle_for_fatigue,
                )
                if adj.fatigue_override:
                    last_weight = adj.weight_lbs
                    fatigue_override_flag = True
                    recommendation_meta = {
                        "source": (recommendation_meta or {}).get("source") or "default",
                        "confidence": adj.confidence,
                        "reason": adj.reason,
                    }

        if snap_load_lbs is not None and last_weight is not None and last_weight > 0:
            snapped_last = snap_load_lbs(
                last_weight,
                equipment_label,
                equipment_settings,
                fallback_increment=effective_increment_lbs,
            )
            if snapped_last is not None:
                last_weight = float(snapped_last)

        prescription = ExercisePrescription(
            exercise_name=body.exerciseName,
            category=ex_category,
            planned_sets=planned_sets,
            increment_lbs=max(1.0, effective_increment_lbs),
            progression_priority=map_progression_priority(goal_type),
            default_start_weight_lbs=last_weight,
        )
        readiness  = ReadinessInput(
            sleep_hours=body.sleepHours,
            energy_1_to_5=body.energy1to5,
            soreness_1_to_5=body.soreness1to5,
            stress_1_to_5=body.stress1to5,
            calories_on_target_recently=body.caloriesOnTargetRecently,
        )
        rec = progression_engine.recommend_next_set(
            profile=profile,
            workout=workout,
            prescription=prescription,
            sets_completed_this_workout=sets_completed,
            readiness=readiness,
            target_rep_override=parse_target_reps(body.targetReps),
        )

        if rec.action.value == "end_exercise":
            trace = _live_recommendation_trace(
                set_intent=(rec.debug or {}).get("current_set_type"),
                previous_set_classification=(rec.debug or {}).get("classification"),
                target_rep_range=body.targetReps,
                prior_weight=float(last_weight or 0) or None,
                recommended_weight=float(last_weight or 0),
                recommended_reps=0,
                adjustment_reason=rec.action.value,
                fatigue_applied=fatigue_override_flag or bool((rec.debug or {}).get("fatigue_drop_reps")),
                rir_used=body.lastSets[-1].rir if body.lastSets else None,
            )
            recommendation_meta = _with_recommendation_metadata(
                recommendation_meta,
                data_source=_recommendation_data_source(
                    (recommendation_meta or {}).get("source"),
                    has_session_sets=bool(sets_completed),
                ),
            )
            return {
                "weightLbs": float(last_weight or 0),
                "reps": 0,
                "tip": f"{body.exerciseName} complete for today.",
                "action": rec.action.value,
                "debug": rec.debug,
                "recommendation": recommendation_meta,
                "fatigue_override": fatigue_override_flag,
                "algorithmSource": LIVE_RECOMMENDATION_ALGORITHM_SOURCE,
                "dataSource": (recommendation_meta or {}).get("dataSource") or "session_state",
                "confidence": (recommendation_meta or {}).get("confidence"),
                "reasonTags": _reason_tags_for_live_response(
                    action=rec.action.value,
                    debug=rec.debug,
                    suspicion_reasons=[],
                    fatigue_applied=fatigue_override_flag,
                ),
                "trace": trace,
            }

        rec_weight = float(rec.recommended_weight_lbs or last_weight or 0)
        rep_min    = int(rec.target_rep_min or 8)
        rep_max    = int(rec.target_rep_max or rep_min)
        rec_reps   = max(1, round((rep_min + rep_max) / 2))

        last_logged = body.lastSets[-1] if body.lastSets else None
        last_logged_feel = (getattr(last_logged, "feedback", None) or None) if last_logged else None

        reviewed_source = "deterministic"
        reviewed_reasons: list[str] = []
        reviewed_action_override: str | None = None
        reviewed_load_increase_override = False
        if last_logged is not None:
            try:
                from app.services.workout.in_workout_review import (
                    reviewed_next_set_recommendation,
                )
                completed_set_number = int(last_logged.setNumber or 1)
                spp = _review_planned_set_from_live_scheme(
                    body.setScheme,
                    completed_set_number=completed_set_number,
                    fallback_target_reps=body.targetReps or f"{rep_min}-{rep_max}",
                    fallback_weight_lbs=float(last_weight or 0.0) or None,
                )
                exercise_stub = {
                    **exercise_meta,
                    "equipment_bucket": exercise_meta.get("equipment_bucket")
                    or ("barbell" if ex_category == ExerciseCategory.COMPOUND else "dumbbell"),
                    "is_compound": bool(exercise_meta.get("is_compound"))
                    or ex_category == ExerciseCategory.COMPOUND,
                }
                prev_sets_this = [
                    {"reps": s.reps, "weight_lbs": s.weightLbs, "rir": s.rir, "feel": s.feedback}
                    for s in body.lastSets[:-1]
                ]
                reviewed = reviewed_next_set_recommendation(
                    exercise=exercise_stub,
                    planned_set=spp,
                    actual_reps=int(last_logged.reps or 0),
                    actual_weight_lbs=float(last_logged.weightLbs or 0.0),
                    actual_rir=float(last_logged.rir) if last_logged.rir is not None else None,
                    feel=last_logged_feel,
                    previous_sets_this_session=prev_sets_this,
                    last_session_sets=[],  # live DB query skipped here — cheap path
                    require_feel=False,
                )
                if reviewed is not None:
                    reviewed_source = reviewed.source
                    reviewed_reasons = reviewed.suspicion_reasons
                    reviewed_load_increase_override = _should_use_reviewed_load_increase(
                        reviewed=reviewed,
                        planned_set=spp,
                        actual_reps=int(last_logged.reps or 0),
                        actual_rir=float(last_logged.rir) if last_logged.rir is not None else None,
                        feel=last_logged_feel,
                    )
                    use_reviewed_payload = reviewed.source != "deterministic" or reviewed_load_increase_override
                    # For meaningful RIR-backed overshoots, the deterministic
                    # set-programming reviewer can override the older
                    # progression engine and stale top-set/backoff targets.
                    if reviewed.next_set_weight_lbs is not None and use_reviewed_payload:
                        rec_weight = float(reviewed.next_set_weight_lbs)
                    if reviewed.next_set_rep_target and use_reviewed_payload:
                        # Best-effort parse of "6-8" → rep_min / rep_max.
                        r = reviewed.next_set_rep_target
                        if "-" in r:
                            try:
                                lo, hi = r.split("-", 1)
                                rep_min = int(lo.strip())
                                rep_max = int(hi.strip())
                                rec_reps = max(1, round((rep_min + rep_max) / 2))
                            except (ValueError, TypeError):
                                pass
                    if reviewed.explanation and use_reviewed_payload:
                        tip = reviewed.explanation
                        reviewed_action_override = reviewed.action
                    else:
                        tip = rec.coach_message
                else:
                    tip = rec.coach_message
            except Exception as e:
                print(f"[recommend-weight] in-workout review failed (non-fatal): {e}")
                tip = rec.coach_message
        else:
            tip = rec.coach_message

        response_action = rec.action.value
        if reviewed_action_override:
            response_action = {
                "increase_load": "increase",
                "reduce_load": "decrease",
                "hold_load": "hold",
                "keep_reps": "hold",
                "add_rep": "hold",
            }.get(reviewed_action_override, response_action)
        planned_backoff_weight = _planned_backoff_transition_weight(
            body.setScheme,
            completed_set_number=last_logged.setNumber if last_logged else None,
            next_set_number=rec.next_set_number,
            completed_actual_weight_lbs=last_logged.weightLbs if last_logged else None,
            increment_lbs=effective_increment_lbs,
        )
        skip_planned_backoff = (
            response_action == "increase"
            and (
                reviewed_load_increase_override
                or any("big overshoot" in r for r in reviewed_reasons)
            )
        )
        if planned_backoff_weight is not None and last_logged is not None and not skip_planned_backoff:
            rec_weight = float(planned_backoff_weight)
            response_action = (
                "decrease"
                if rec_weight < float(last_logged.weightLbs or 0.0)
                else "hold"
            )
            rep_target = f"{rep_min}-{rep_max}"
            tip = (
                f"Backoff set: drop to {int(rec_weight) if rec_weight.is_integer() else rec_weight} "
                f"lb for {rep_target}. The lighter load is intentional after your top set."
            )

        if snap_load_lbs is not None and rec_weight > 0:
            snapped_rec = snap_load_lbs(
                rec_weight,
                equipment_label,
                equipment_settings,
                fallback_increment=effective_increment_lbs,
            )
            if snapped_rec is not None:
                original_rec_weight = rec_weight
                rec_weight = float(snapped_rec)
                if abs(rec_weight - original_rec_weight) > 0.01:
                    tip = _loadability_adjusted_text(original_rec_weight, rec_weight)

        recommendation_meta = _with_recommendation_metadata(
            recommendation_meta,
            data_source=_recommendation_data_source(
                (recommendation_meta or {}).get("source"),
                has_session_sets=bool(sets_completed),
            ),
        )
        data_source = (recommendation_meta or {}).get("dataSource") or _recommendation_data_source(
            None,
            has_session_sets=bool(sets_completed),
        )
        confidence = (recommendation_meta or {}).get("confidence")
        reason_tags = _reason_tags_for_live_response(
            action=response_action,
            debug=rec.debug,
            suspicion_reasons=reviewed_reasons,
            fatigue_applied=fatigue_override_flag,
        )
        trace = _live_recommendation_trace(
            set_intent=(rec.debug or {}).get("next_set_type") or (rec.debug or {}).get("current_set_type"),
            previous_set_classification=(rec.debug or {}).get("classification"),
            target_rep_range=f"{rep_min}-{rep_max}",
            prior_weight=(
                float(last_logged.weightLbs or 0.0)
                if last_logged is not None
                else (float(last_weight or 0.0) if last_weight else None)
            ),
            recommended_weight=rec_weight,
            recommended_reps=rec_reps,
            adjustment_reason=response_action,
            fatigue_applied=fatigue_override_flag or bool((rec.debug or {}).get("fatigue_drop_reps")),
            rir_used=last_logged.rir if last_logged is not None else None,
        )
        ai_safety = prepare_ai_safety_review(
            _ai_safety_payload_for_next_set(
                body=body,
                exercise_meta=exercise_meta,
                numeric_load=metadata_increment_lbs > 0,
                recommended_weight_lbs=rec_weight,
                recommended_reps=rec_reps,
                data_source=data_source,
                confidence=confidence,
                action=response_action,
                reason_tags=reason_tags,
            ),
            user_id=getattr(current_user, "id", None),
            background_tasks=background_tasks,
        )

        return {
            "weightLbs": rec_weight,
            "reps": rec_reps,
            "tip": tip,
            "action": response_action,
            "repRange": f"{rep_min}-{rep_max}",
            "debug": rec.debug,
            # Null when the anchor came from current-session sets — the
            # progression engine owns that message. Populated for first-set
            # anchors so the UI can show "Based on your last 3 sessions"
            # or "Estimated from similar horizontal pressing work".
            "recommendation": recommendation_meta,
            # New fields for the live reviewer pipeline:
            # `awaitingFeel`: frontend hides the rec card while True.
            # `source`: currently "deterministic".
            # `suspicionReasons`: debug list of why the reviewer flagged it.
            "awaitingFeel": False,
            "source": reviewed_source,
            "suspicionReasons": reviewed_reasons,
            "algorithmSource": LIVE_RECOMMENDATION_ALGORITHM_SOURCE,
            "dataSource": data_source,
            "confidence": confidence,
            "reasonTags": reason_tags,
            "trace": trace,
            "aiSafety": ai_safety,
            # Top-level flag so the UI can style the rec differently
            # (e.g. "recovering" badge) without parsing the reason
            # string. True iff the fatigue overlay downshifted the
            # weight; False in every other case.
            "fatigue_override": fatigue_override_flag,
        }
    except Exception as e:
        print(f"[BACKEND] recommend-weight error: {e}")
        raise HTTPException(status_code=502, detail=f"Recommendation failed: {str(e)}")


# Canonical list of "showcase" compound lifts to surface on the
# Progress screen's 1RM card. Kept as a flat tuple (no config/env)
# so the Progress screen always renders the same set of lifts and
# users don't see the list flap between releases. Ordered by how
# commonly strength standards reference them.
_ONE_RM_SHOWCASE_SLUGS: tuple[str, ...] = (
    "barbell_back_squat",
    "barbell_bench_press",
    "barbell_deadlift",
    "overhead_press",
    "barbell_row",
    "pendlay_row",
    "barbell_front_squat",
    "romanian_deadlift",
)


def _build_showcase_lifts(
    profiles: dict,
    sets_by_name: dict,
    showcase_slugs: tuple[str, ...] = _ONE_RM_SHOWCASE_SLUGS,
    *,
    strength_signals: dict | None = None,
) -> list[dict]:
    """Pure helper: overlay rolling-e1RM on top of Epley `estimated_1rm_lbs`
    so the showcase tile matches the chart + PR cards.

    Args:
      profiles: ``{slug: ExercisePerformance}`` from ``build_performance_profile``.
      sets_by_name: ``{exercise_name_lower: [UsableSet, ...]}`` aggregated
        from the user's logged sets. Empty dict is fine.
      showcase_slugs: ordered tuple of slugs to render. Defaults to the
        canonical showcase list.
      strength_signals: optional ``{slug: StrengthSignal}`` from
        ``build_strength_signal_profile``. When present, the lift dict
        also carries trend / freshSetCount / dataQuality fields and the
        ``oneRepMaxLbs`` prefers the fatigue-aware signal — falls back
        to the rolling overlay when freshness data is sparse so an
        early-career user still sees a number.

    Returns the list of lift dicts the route ships in ``{"lifts": [...]}``.
    Extracted from the route handler so the rolling overlay is directly
    unit-testable without seeding ``Exercise`` rows.
    """
    from app.services.workout.rolling_e1rm import compute_rolling_e1rm

    out: list[dict] = []
    for slug in showcase_slugs:
        p = profiles.get(slug)
        if p is None or p.estimated_1rm_lbs <= 0:
            continue
        rolling_lbs: float | None = None
        sets_for_lift = sets_by_name.get((p.name or "").strip().lower())
        if sets_for_lift:
            est = compute_rolling_e1rm(sets_for_lift, role="primary")
            if est is not None and est.e1rm_lbs > 0:
                rolling_lbs = est.e1rm_lbs

        # Prefer the freshness-aware signal when available + non-rough.
        # Falls back to rolling, then to plain Epley. The "rough" tag
        # is reserved for the explicit raw top-set fallback so the UI
        # can show a "based on raw top sets" caveat when shown.
        sig = (strength_signals or {}).get(slug)
        signal_lbs: float | None = None
        signal_quality = "rough"
        if sig is not None and sig.estimated_one_rep_max > 0 and sig.data_quality != "missing":
            signal_lbs = sig.estimated_one_rep_max
            signal_quality = sig.data_quality

        display_1rm = (
            signal_lbs
            if signal_lbs is not None
            else (rolling_lbs if rolling_lbs is not None else p.estimated_1rm_lbs)
        )
        entry = {
            "slug": p.slug,
            "name": p.name,
            "oneRepMaxLbs": round(display_1rm, 1),
            "topWeightLbs": round(p.recent_top_weight_lbs, 1),
            "topReps": int(p.recent_top_reps),
            "sessionCount": int(p.session_count),
            "confidence": round(p.confidence, 2),
            "lastPerformedOn": p.last_performed_on.isoformat() if p.last_performed_on else None,
            # Always-present new fields. When no signal is available
            # they describe the fallback ("rough") so the UI can still
            # render a caveat instead of the fields being absent.
            "trend28dPct": sig.trend_28d_pct if sig else None,
            "trend56dPct": sig.trend_56d_pct if sig else None,
            "freshSetCount": int(sig.fresh_set_count) if sig else 0,
            "signalConfidence": sig.confidence if sig else "low",
            "dataQuality": signal_quality,
        }
        out.append(entry)
    return out


@router.get("/strength/one-rep-max")
def one_rep_max_showcase(
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Return estimated 1RM for the user's showcase compound lifts.

    Pulls from `build_performance_profile` which already computes
    Epley 1RMs from recent logged sessions. Only lifts with at least
    one logged session in the performance window are returned — the
    Progress screen card renders those. Lifts with no history are
    skipped entirely (the UI shows its own empty-state when nothing
    comes back).

    Shape:
        {
          "lifts": [
            {
              "slug": "barbell_bench_press",
              "name": "Barbell Bench Press",
              "oneRepMaxLbs": 235.0,
              "topWeightLbs": 205.0,
              "topReps": 8,
              "sessionCount": 4,
              "confidence": 0.77,
              "lastPerformedOn": "2026-04-14"
            },
            ...
          ]
        }
    """
    try:
        profiles = build_performance_profile(current_user.id, db)
    except Exception as e:
        print(f"[one-rep-max] profile build failed: {e}")
        return {"lifts": []}

    # Pull rolling-e1RM map so the showcase number matches the chart and
    # the per-PR cards. Without this, three places on the screen show
    # three different numbers for the same lift (Epley single-set vs.
    # rolling RIR-adjusted weighted-median). The actual overlay logic
    # lives in `_build_showcase_lifts` for testability.
    from app.models import ExerciseSet, WorkoutExercise, WorkoutSession
    from app.services.workout.rolling_e1rm import UsableSet
    rows = db.exec(
        select(ExerciseSet, WorkoutExercise, WorkoutSession)
        .join(WorkoutExercise, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .join(WorkoutSession, WorkoutExercise.session_id == WorkoutSession.id)
        .where(
            WorkoutSession.user_id == current_user.id,
            ExerciseSet.completed == True,  # noqa: E712
        )
    ).all()
    sets_by_name: dict[str, list[UsableSet]] = {}
    for es, we, ws in rows:
        nk = (we.name or "").strip().lower()
        if not nk:
            continue
        sets_by_name.setdefault(nk, []).append(UsableSet(
            completed_at=es.completed_at or ws.workout_date,
            actual_weight_lbs=es.actual_weight_lbs or 0,
            actual_reps=es.actual_reps or 0,
            actual_rir=es.actual_rir,
            target_rir=es.rir_target,
            set_type=es.set_type,
        ))

    # Fatigue-aware Fresh Strength Signal. When a user logs RIR + the
    # showcase lift sits early in the session, this is the honest
    # number. When the data is sparse / always-late, the helper
    # returns `data_quality='partial'` and `_build_showcase_lifts`
    # falls back to the rolling overlay so the tile still renders.
    try:
        from app.services.workout.strength_signal import build_strength_signal_profile
        strength_signals = build_strength_signal_profile(
            current_user.id, db, only_slugs=_ONE_RM_SHOWCASE_SLUGS,
        )
    except Exception as e:
        print(f"[one-rep-max] strength signal build failed (non-fatal): {e}")
        strength_signals = {}

    return {"lifts": _build_showcase_lifts(profiles, sets_by_name, strength_signals=strength_signals)}


@router.get("/fitness/composite-score")
def fitness_composite_score(
    days_per_week: int = 3,
    bodyweight_lbs: float | None = None,
    recent_sleep_hours: float | None = None,
    avg_session_rpe: float | None = None,
    current_user: User = Depends(require_pro_feature("Advanced fitness score")),
    db: Session = Depends(get_session),
):
    """Compose the 4-pillar fitness score (Strength, Cardio,
    Consistency, Recovery). Each pillar is deterministic and returns
    a 0-100 subscore plus a one-line human reason string.

    Query params:
      - `days_per_week` — user's planned training frequency (powers Consistency pillar target)
      - `bodyweight_lbs` — current bodyweight (powers Strength pillar)
      - `recent_sleep_hours` — last night's sleep (Recovery signal)
      - `avg_session_rpe` — avg RPE across recent sessions (Recovery signal)

    Internal data sources:
      - `build_performance_profile` for Strength pillar (Epley 1RMs)
      - `WorkoutCompletion` last 14 days for Cardio + Consistency

    `total` is a 28-day moving average of the daily score (smoothed
    headline). `rawTotal` is today's instant score, and `pillars` are
    today's instant subscores — the breakdown reflects current state
    while the headline trends. A new user with N<28 days of snapshots
    is averaged over the N they have (`sampleCount`). Pillar targets
    also adapt: a user whose first workout was <14/28 days ago is
    scored against a pro-rated window, not a full one.

    Returns:
        {
          "total": 70.1,          # 28-day moving average (headline)
          "rawTotal": 72.5,       # today's instant score
          "rating": "Strong",     # band of `total`
          "windowDays": 28,
          "sampleCount": 12,      # daily snapshots inside the window
          "pillars": [
            {"name": "Strength", "score": 97.9, "reason": "...", "dataQuality": "full"},
            {"name": "Cardio", "score": 19.0, "reason": "...", "dataQuality": "full"},
            {"name": "Consistency", "score": 80.0, "reason": "...", "dataQuality": "full"},
            {"name": "Recovery", "score": 100.0, "reason": "...", "dataQuality": "full"}
          ]
        }
    """
    from datetime import datetime, timedelta, date
    from app.services.workout.fitness_score import compute_fitness_score, _rating_for
    from app.models import (
        WorkoutCompletion,
        WorkoutSession,
        WorkoutExercise,
        ExerciseSet,
        Exercise as SeedExercise,
        FitnessScoreSnapshot,
        DailyHealthSnapshot,
    )

    try:
        profiles = build_performance_profile(current_user.id, db)
    except Exception as e:
        print(f"[fitness-score] profile build failed: {e}")
        profiles = {}

    # Pull the last 14 days of lightweight completion rows for the
    # Cardio + Consistency pillars. Uses the same reliable source
    # the 36-hour continuity rotation already reads from.
    # Naive UTC — matches TIMESTAMP WITHOUT TIME ZONE storage of
    # WorkoutCompletion.completed_at. Replaces deprecated datetime.utcnow().
    from datetime import timezone as _tz
    _now_naive = datetime.now(_tz.utc).replace(tzinfo=None)
    today = _now_naive.date()
    cutoff_14d = _now_naive - timedelta(days=14)
    cutoff_28d = _now_naive - timedelta(days=28)
    cutoff_56d = _now_naive - timedelta(days=56)
    try:
        rows = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.completed_at >= cutoff_14d)
            .order_by(WorkoutCompletion.completed_at.desc())
        ).all()
    except Exception as e:
        print(f"[fitness-score] recent completions query failed: {e}")
        rows = []

    def _completion_to_dict(r: WorkoutCompletion) -> dict:
        return {
            "focus": r.focus_label,
            "duration_seconds": r.duration_seconds,
            "workout_date": r.workout_date.isoformat() if r.workout_date else None,
            "activity_category": r.activity_category,
            "activity_subtype": r.activity_subtype,
            "cardio_style": r.cardio_style,
            "distance_miles": r.distance_miles,
            "hr_summary": r.hr_summary,
            "cardio_load": r.cardio_load,
        }

    recent_completions = [_completion_to_dict(r) for r in rows]
    session_count_14d = len(rows)

    # Prior-window completions (days 15–28 ago) feed the cardio
    # progression sub-pillar. Best-effort; failure just skips the signal.
    prior_window_completions: list[dict] | None = None
    try:
        prior_rows = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.completed_at >= cutoff_28d)
            .where(WorkoutCompletion.completed_at < cutoff_14d)
            .order_by(WorkoutCompletion.completed_at.desc())
        ).all()
        prior_window_completions = [_completion_to_dict(r) for r in prior_rows]
    except Exception as e:
        print(f"[fitness-score] prior-window completions query failed (non-fatal): {e}")
        prior_window_completions = None

    vo2_max: float | None = None
    try:
        latest_vo2 = db.exec(
            select(DailyHealthSnapshot.vo2_max)
            .where(DailyHealthSnapshot.user_id == current_user.id)
            .where(DailyHealthSnapshot.vo2_max != None)  # noqa: E711
            .order_by(DailyHealthSnapshot.snapshot_date.desc())
        ).first()
        if latest_vo2 is not None:
            vo2_max = float(latest_vo2)
    except Exception as e:
        print(f"[fitness-score] VO2 lookup failed (non-fatal): {e}")
        vo2_max = None

    # ── Strength pillar inputs ────────────────────────────────────
    # Walk the structured WorkoutSession + WorkoutExercise + ExerciseSet
    # tables to compute the four sub-component inputs:
    #   - patterns_hit: set of movement patterns trained in the last 28d
    #   - volume_load_lbs: total weight × reps across all sets in 28d
    #   - distinct_exercises: count of unique exercise names in 28d
    #   - progression_ratio: fraction of exercises whose top set
    #     improved from the prior 28-day window to the current one
    # All best-effort; failures degrade strength but don't crash.
    patterns_hit: set[str] = set()
    volume_load_lbs = 0.0
    distinct_exercise_names: set[str] = set()
    progression_ratio = 0.0
    try:
        # Build a slug → movement_pattern map from the seed catalog.
        seed_rows = db.exec(select(SeedExercise)).all()
        slug_to_pattern: dict[str, str] = {}
        name_to_pattern: dict[str, str] = {}
        for sx in seed_rows:
            pat = (getattr(sx, "movement_pattern", None) or "").strip().lower()
            if pat:
                if sx.slug:
                    slug_to_pattern[sx.slug] = pat
                if sx.name:
                    name_to_pattern[sx.name.strip().lower()] = pat

        # Pull all sessions from the last 28 days.
        recent_sessions_28d = db.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == current_user.id)
            .where(WorkoutSession.workout_date >= cutoff_28d.date())
        ).all()
        recent_session_ids = [s.id for s in recent_sessions_28d if s.id is not None]

        if recent_session_ids:
            recent_exs = db.exec(
                select(WorkoutExercise)
                .where(WorkoutExercise.session_id.in_(recent_session_ids))
            ).all()
            ex_id_to_name: dict[int, str] = {}
            for ex in recent_exs:
                if ex.id is None:
                    continue
                ex_id_to_name[ex.id] = (ex.name or "").strip()
                lname = (ex.name or "").strip().lower()
                if lname:
                    distinct_exercise_names.add(lname)
                    pat = name_to_pattern.get(lname)
                    if pat:
                        patterns_hit.add(pat)

            recent_sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.workout_exercise_id.in_(list(ex_id_to_name.keys())))
            ).all()
            # Volume load: sum of (actual_weight × actual_reps) across
            # every set in the window. Ignores zero-weight bodyweight
            # rows since they don't contribute to weight·reps load.
            for s in recent_sets:
                w = s.actual_weight_lbs or 0
                r = s.actual_reps or 0
                if w > 0 and r > 0:
                    volume_load_lbs += w * r

            # Progression ratio: for each exercise name, compute the
            # top-set "score" (weight × reps) in the current 28d window
            # vs the prior 28d window. Fraction of exercises whose
            # current top is >= prior top is the progression ratio.
            current_top: dict[str, float] = {}
            for ex_id, ex_name in ex_id_to_name.items():
                ex_sets = [s for s in recent_sets if s.workout_exercise_id == ex_id]
                if not ex_sets:
                    continue
                top = max(
                    ((s.actual_weight_lbs or 0) * (s.actual_reps or 0))
                    for s in ex_sets
                )
                key = ex_name.lower()
                if top > 0:
                    current_top[key] = max(current_top.get(key, 0.0), top)

            # Prior window: 28-56 days ago
            prior_sessions = db.exec(
                select(WorkoutSession)
                .where(WorkoutSession.user_id == current_user.id)
                .where(WorkoutSession.workout_date >= cutoff_56d.date())
                .where(WorkoutSession.workout_date < cutoff_28d.date())
            ).all()
            prior_session_ids = [s.id for s in prior_sessions if s.id is not None]
            prior_top: dict[str, float] = {}
            if prior_session_ids:
                prior_exs = db.exec(
                    select(WorkoutExercise)
                    .where(WorkoutExercise.session_id.in_(prior_session_ids))
                ).all()
                prior_ex_ids = [e.id for e in prior_exs if e.id is not None]
                prior_ex_id_to_name = {e.id: (e.name or "").strip().lower() for e in prior_exs if e.id}
                if prior_ex_ids:
                    prior_sets = db.exec(
                        select(ExerciseSet)
                        .where(ExerciseSet.workout_exercise_id.in_(prior_ex_ids))
                    ).all()
                    for s in prior_sets:
                        w = s.actual_weight_lbs or 0
                        r = s.actual_reps or 0
                        if w > 0 and r > 0:
                            key = prior_ex_id_to_name.get(s.workout_exercise_id, "")
                            if key:
                                prior_top[key] = max(prior_top.get(key, 0.0), w * r)

            # Compare per exercise. Exercises only in the current window
            # count as "new" — they're a positive signal so we credit them.
            if current_top:
                improved = 0
                for name, cur in current_top.items():
                    prev = prior_top.get(name, 0.0)
                    if prev <= 0 or cur >= prev:
                        improved += 1
                progression_ratio = improved / len(current_top)
    except Exception as e:
        print(f"[fitness-score] strength sub-component query failed (non-fatal): {e}")

    # Look up user's age so the fitness score baselines can be age-banded.
    user_age: int | None = None
    try:
        from app.models import UserProfile as UserProfileModel
        profile_row = db.exec(
            select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
        ).first()
        user_age = profile_row.age if profile_row else None
    except Exception:
        user_age = None

    # Build the fatigue-aware Fresh Strength Signal so the Strength
    # pillar's compound-base sub-score reflects clean strength, not
    # late-session top sets. Falls back per-slug to the raw profile
    # eRM when fresh data is sparse (see _score_strength_compound_base).
    try:
        from app.services.workout.strength_signal import build_strength_signal_profile
        strength_signals = build_strength_signal_profile(current_user.id, db)
    except Exception as e:
        print(f"[fitness-score] strength signal build failed (non-fatal): {e}")
        strength_signals = {}

    # ── Adaptive-window input ─────────────────────────────────────
    # Days since the user's first logged workout. When shorter than a
    # pillar's 14-/28-day window the pillar target scales down so a
    # newer user with a strong first week isn't measured against a
    # full-window bar. Looks at both WorkoutCompletion (front-page
    # completions) and WorkoutSession (structured logs) and takes the
    # earlier of the two. None → compute_fitness_score uses full windows.
    history_days: int | None = None
    try:
        first_dates: list[date] = []
        earliest_completion = db.exec(
            select(WorkoutCompletion.completed_at)
            .where(WorkoutCompletion.user_id == current_user.id)
            .order_by(WorkoutCompletion.completed_at.asc())
        ).first()
        if earliest_completion is not None:
            first_dates.append(
                earliest_completion.date()
                if hasattr(earliest_completion, "date")
                else earliest_completion
            )
        earliest_session = db.exec(
            select(WorkoutSession.workout_date)
            .where(WorkoutSession.user_id == current_user.id)
            .order_by(WorkoutSession.workout_date.asc())
        ).first()
        if earliest_session is not None:
            first_dates.append(earliest_session)
        if first_dates:
            history_days = max(1, (today - min(first_dates)).days + 1)
    except Exception as e:
        print(f"[fitness-score] history_days lookup failed (non-fatal): {e}")
        history_days = None

    score = compute_fitness_score(
        profiles=profiles,
        bodyweight_lbs=bodyweight_lbs,
        recent_completions=recent_completions,
        session_count_14d=session_count_14d,
        days_per_week=int(days_per_week or 3),
        recent_sleep_hours=recent_sleep_hours,
        avg_session_rpe=avg_session_rpe,
        patterns_hit=patterns_hit,
        volume_load_lbs=volume_load_lbs,
        distinct_exercises=len(distinct_exercise_names),
        progression_ratio=progression_ratio,
        user_age=user_age,
        vo2_max=vo2_max,
        history_days=history_days,
        strength_signals=strength_signals,
        prior_window_completions=prior_window_completions,
    )

    # ── Persist today's reading + return the 28-day moving average ──
    # The headline `total` the client shows is the average of the
    # daily snapshots over the last 28 days — or however many exist,
    # so a brand-new user just sees today's value (sampleCount 1).
    # `rawTotal` carries today's instant score so the smoothing stays
    # inspectable. Snapshots are sampled on each call (one row per day,
    # upserted), not by a cron — a user who opens the app rarely gets
    # fewer samples in the window, which is the intended behavior.
    result = score.to_dict()
    raw_total = result["total"]
    result["rawTotal"] = raw_total
    result["windowDays"] = 28
    result["sampleCount"] = 1
    try:
        pillar_by_name = {p.name: round(p.score, 2) for p in score.pillars}
        existing = db.exec(
            select(FitnessScoreSnapshot)
            .where(FitnessScoreSnapshot.user_id == current_user.id)
            .where(FitnessScoreSnapshot.snapshot_date == today)
        ).first()
        if existing is not None:
            existing.total = raw_total
            existing.strength = pillar_by_name.get("Strength", 0.0)
            existing.cardio = pillar_by_name.get("Cardio", 0.0)
            existing.consistency = pillar_by_name.get("Consistency", 0.0)
            existing.recovery = pillar_by_name.get("Recovery", 0.0)
            db.add(existing)
        else:
            db.add(FitnessScoreSnapshot(
                user_id=current_user.id,
                snapshot_date=today,
                total=raw_total,
                strength=pillar_by_name.get("Strength", 0.0),
                cardio=pillar_by_name.get("Cardio", 0.0),
                consistency=pillar_by_name.get("Consistency", 0.0),
                recovery=pillar_by_name.get("Recovery", 0.0),
            ))
        db.commit()

        window_start = today - timedelta(days=27)  # 28-day inclusive window
        snaps = db.exec(
            select(FitnessScoreSnapshot.total)
            .where(FitnessScoreSnapshot.user_id == current_user.id)
            .where(FitnessScoreSnapshot.snapshot_date >= window_start)
        ).all()
        if snaps:
            smoothed = sum(snaps) / len(snaps)
            result["total"] = round(smoothed, 1)
            result["rating"] = _rating_for(smoothed)
            result["sampleCount"] = len(snaps)
    except Exception as e:
        print(f"[fitness-score] snapshot / moving-average failed (non-fatal): {e}")
        db.rollback()
    return result


# ── MET classification for calorie estimation ────────────────────────
# Explicit mapping from known focus labels (archetype default_name values)
# to MET categories. Avoids fragile substring matching.
_CARDIO_FOCUS_LABELS: frozenset[str] = frozenset({
    "zone 2 cardio", "short intervals", "long intervals",
    "tempo / threshold", "metabolic circuit", "mixed conditioning",
    "sprint + power",
})
_STRENGTH_FOCUS_LABELS: frozenset[str] = frozenset({
    "full body — strength",
})
# training_type keywords for archetype-derived labels
_CARDIO_TRAINING_TYPES: frozenset[str] = frozenset({
    "conditioning", "cardio",
})
_STRENGTH_TRAINING_TYPES: frozenset[str] = frozenset({
    "strength", "power",
})


def _met_for_focus(focus: str) -> float:
    """Classify workout focus → MET value for calorie estimation.
    Uses explicit label lookup first, falls back to keyword scan."""
    from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META

    focus_l = focus.lower().strip()

    # 1. Try exact match against known archetype default_name values
    if focus_l in _CARDIO_FOCUS_LABELS:
        return 8.0
    if focus_l in _STRENGTH_FOCUS_LABELS:
        return 6.5

    # 2. Try to resolve via archetype enum → training_type
    for arch, meta in ARCHETYPE_META.items():
        if meta.default_name.lower() == focus_l:
            if meta.training_type in _CARDIO_TRAINING_TYPES:
                return 8.0
            if meta.training_type in _STRENGTH_TRAINING_TYPES:
                return 6.5
            return 5.5

    # 3. Fallback for free-text focus labels not matching any archetype
    if any(kw in focus_l for kw in ("cardio", "run", "cycle", "hiit", "conditioning")):
        return 8.0
    if any(kw in focus_l for kw in ("strength", "power", "heavy")):
        return 6.5
    return 5.5


@router.post("/workout-summary")
def generate_workout_summary(
    body: WorkoutSummaryRequest,
    current_user: User = Depends(require_pro_feature("AI workout summaries")),
    db: Session = Depends(get_session),
):
    """AI post-workout summary: calories burned, achievements, and personalised recommendations."""
    weight_kg      = body.weightLbs / 2.205
    duration_hours = body.durationSeconds / 3600

    met = _met_for_focus(body.focus)

    estimated_calories = max(1, round(met * weight_kg * duration_hours))
    calories_burned = (
        int(body.caloriesBurned)
        if body.caloriesBurned is not None and int(body.caloriesBurned) > 0
        else estimated_calories
    )

    total_sets     = sum(len(ex.get("sets", [])) for ex in body.exercises)
    exercises_done = sum(1 for ex in body.exercises if len(ex.get("sets", [])) > 0)
    achievements: list[str] = []
    for ex in body.exercises:
        sets = ex.get("sets", [])
        if sets:
            best   = max(sets, key=lambda s: s.get("weightLbs", 0) * s.get("reps", 0))
            weight = best.get("weightLbs", 0)
            reps   = best.get("reps", 0)
            if weight > 0:
                achievements.append(f"{ex['name']}: {weight} lbs × {reps} reps")

    hr_summary = body.hrSummary if isinstance(body.hrSummary, dict) else {}
    hr_avg = hr_summary.get("avgBpm")
    hr_max = hr_summary.get("maxBpm")
    zone_minutes = hr_summary.get("zoneMinutes")
    hr_line = "  (no heart-rate data)"
    if isinstance(zone_minutes, list) and len(zone_minutes) >= 5:
        try:
            z2 = float(zone_minutes[1] or 0)
            z3p = sum(float(zone_minutes[i] or 0) for i in range(2, 5))
            hr_line = (
                f"  Avg HR {int(round(float(hr_avg)))} bpm, max {int(round(float(hr_max)))} bpm, "
                f"{round(z2, 1)} min Z2, {round(z3p, 1)} min Z3+"
            )
        except Exception:
            hr_line = "  (heart-rate data unavailable)"
    elif hr_avg or hr_max:
        hr_line = f"  Avg HR {hr_avg or 'n/a'} bpm, max {hr_max or 'n/a'} bpm"

    def _has_prior_best(p: dict) -> bool:
        try:
            return float(p.get("old_value") or 0) > 0
        except (TypeError, ValueError):
            return False

    established_prs = [
        p for p in (body.prs or [])
        if isinstance(p, dict) and _has_prior_best(p)
    ]
    pr_lines = []
    for p in established_prs[:6]:
        name = str(p.get("exercise_name") or "Exercise")
        kind = str(p.get("kind") or "record").replace("_", " ")
        new_value = p.get("new_value")
        old_value = p.get("old_value")
        pr_lines.append(f"  {name}: {kind} {new_value} (prev {old_value})")

    api_key = get_openai_api_key()
    if not api_key:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Solid effort — every set counts toward your goal. Keep showing up!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours for optimal recovery.",
                "Hydrate well — aim for at least 16 oz of water post-workout.",
                "Sleep 7–9 hours tonight to lock in the gains from this session.",
            ],
        }

    # Pull the most recent comparable session (same focus) so the AI can
    # make an honest comparison instead of inventing one. Best-effort —
    # failure here silently falls back to "no comparison".
    last_session_lines = ""
    last_session_date = None
    try:
        from app.models import WorkoutSession, WorkoutExercise, ExerciseSet
        last = db.exec(
            select(WorkoutSession)
            .where(
                WorkoutSession.user_id == current_user.id,
                WorkoutSession.focus == body.focus,
            )
            .order_by(WorkoutSession.workout_date.desc(), WorkoutSession.id.desc())
            .limit(2)
        ).all()
        # Skip the most recent (that's THIS session that was just logged);
        # the second hit is the previous comparable session.
        prior = last[1] if len(last) >= 2 else None
        if prior:
            last_session_date = str(prior.workout_date)
            prior_sets = db.exec(
                select(WorkoutExercise.name, ExerciseSet.actual_reps, ExerciseSet.actual_weight_lbs)
                .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
                .where(WorkoutExercise.session_id == prior.id)
                .where(ExerciseSet.completed == True)  # noqa: E712
                .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
                .order_by(WorkoutExercise.order_index, ExerciseSet.set_number)
            ).all()
            per_ex: dict[str, list[str]] = {}
            for name, reps, weight in prior_sets:
                if not name:
                    continue
                per_ex.setdefault(name, []).append(
                    f"{int(reps or 0)}×{int(round(float(weight or 0)))}"
                )
            last_session_lines = "\n".join(
                f"  {name}: {', '.join(sets[:4])}"
                for name, sets in list(per_ex.items())[:6]
            )
    except Exception:
        pass

    client = OpenAI(api_key=api_key)
    try:
        system_prompt = (
            "You are a strength coach writing a grounded 4-part post-workout recap. "
            "You receive today's session + the user's last comparable session (by focus). "
            "Your job: identify what is real in the data, name ONE specific coaching point, "
            "and hedge honestly when the data is mixed.\n\n"
            "FORBIDDEN: 'Great work!', 'Keep pushing!', 'Crush it', generic motivation, "
            "'every rep counts', 'stay consistent'.\n"
            "REQUIRED: Every claim must cite a specific exercise, weight, or rep count "
            "from today or the comparison session, or an explicit heart-rate/PR signal if supplied. "
            "Only mention PRs listed under ESTABLISHED PRS; first-session baselines are not PRs. "
            "If there is no comparison session, "
            "say so in `comparison` and skip the comparison — do not invent one.\n\n"
            "Return JSON only. Single-sentence values, plain prose, no markdown."
        )
        prompt = (
            f"TODAY:\n"
            f"- Focus: {body.focus}\n"
            f"- Goal: {body.goal}\n"
            f"- Duration: {body.durationSeconds // 60} min\n"
            f"- Exercises completed: {exercises_done}\n"
            f"- Total sets logged: {total_sets}\n"
            f"- Calories burned: {calories_burned}\n"
            f"- Heart rate:\n{hr_line}\n"
            f"- Top sets today:\n"
            + ("\n".join(f"  {a}" for a in achievements[:6]) or "  (none logged)")
            + "\n\n"
            "ESTABLISHED PRS (prior best existed before today):\n"
            + ("\n".join(pr_lines) or "  (none)")
            + "\n\n"
            f"LAST COMPARABLE {body.focus.upper()} SESSION "
            f"({last_session_date or 'none on file'}):\n"
            + (last_session_lines or "  (no comparable session in history)")
            + "\n\n"
            "Return JSON with these four fields, in this exact order:\n"
            "{\n"
            '  "headline": "<one sentence, ≤100 chars, what actually happened>",\n'
            '  "comparison": "<one sentence comparing to last session, OR empty string if none>",\n'
            '  "coachingPoint": "<one specific cue for next session, names an exercise>",\n'
            '  "motivation": "<one honest sentence — no generic filler>"\n'
            "}"
        )
        _ws_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
        # New structured schema — keep motivationMessage + recommendations
        # populated for back-compat with the mobile client, but also
        # surface the new structured fields.
        schema = {
            "name": "workout_summary_v2",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["headline", "comparison", "coachingPoint", "motivation"],
                "properties": {
                    "headline": {"type": "string", "maxLength": 120},
                    "comparison": {"type": "string", "maxLength": 200},
                    "coachingPoint": {"type": "string", "maxLength": 200},
                    "motivation": {"type": "string", "maxLength": 160},
                },
            },
        }
        kwargs = _build_chat_kwargs(
            model_chat(),
            _ws_messages,
            json_schema=schema,
            max_tokens=400,
            timeout_secs=30,
            ai_route="/ai/workout-summary",
            ai_user_id=current_user.id,
            ai_budget_bucket="coach_chat",
        )
        response = _chat_create(client, **kwargs)
        ai = _extract_json(response.choices[0].message.content)
        headline       = str(ai.get("headline") or "").strip()
        comparison     = str(ai.get("comparison") or "").strip()
        coaching_point = str(ai.get("coachingPoint") or "").strip()
        motivation     = str(ai.get("motivation") or "").strip()
        # Back-compat: synthesize motivationMessage + recommendations so
        # the mobile client renders something while it catches up.
        legacy_message = motivation or headline or "Session logged."
        legacy_tips = [s for s in (coaching_point, comparison) if s]
        if len(legacy_tips) < 3:
            legacy_tips += [
                "Hydrate well post-workout.",
                "Consume 20-40 g protein within 2 hours.",
                "Aim for 7-9 hours of sleep tonight.",
            ]
        return {
            # New structured fields the upgraded client renders.
            "headline": headline,
            "comparison": comparison,
            "coachingPoint": coaching_point,
            "motivation": motivation,
            # Legacy fields.
            "caloriesBurned": calories_burned,
            "motivationMessage": legacy_message,
            "achievements": achievements[:4],
            "recommendations": legacy_tips[:3],
        }
    except Exception:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Strong session — consistency is the key to progress!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours.",
                "Hydrate well post-workout.",
                "Aim for 7–9 hours of sleep tonight.",
            ],
        }


# ── AI warm-up generator ────────────────────────────────────────────
# Returns 4-6 warm-up steps tailored to today's workout (focus +
# first couple of exercises) and the user's injuries. Frontend caches
# the result by workout day so repeated visits to the same day don't
# re-hit the API. Falls back to a deterministic 4-step template if the
# AI call fails or no API key is set — the active workout screen never
# blocks on this.
_WARMUP_SCHEMA = {
    "name": "warmup_steps",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["steps"],
        "properties": {
            "steps": {
                "type": "array",
                "minItems": 3,
                "maxItems": 6,
                "items": {"type": "string"},
            },
        },
    },
}


# ── Warmup body-region classification ─────────────────────────────────
# Maps known focus labels to warmup body regions via archetype metadata.
# Avoids fragile substring scanning of focus strings.
_WARMUP_REGION_LOWER: frozenset[str] = frozenset({
    "legs", "lower",
})
_WARMUP_REGION_PULL: frozenset[str] = frozenset({
    "pull",
})
_WARMUP_REGION_PUSH_UPPER: frozenset[str] = frozenset({
    "push", "upper",
})
_WARMUP_REGION_RECOVERY: frozenset[str] = frozenset({
    "recovery", "mobility",
})


def _classify_warmup_region(focus: str) -> str:
    """Classify focus label → warmup body region category.
    Returns one of: 'lower', 'pull', 'push_upper', 'recovery', 'general'."""
    from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META, ARCHETYPE_TO_FOCUS_FAMILY

    focus_l = (focus or "").lower().strip()

    # 1. Try to resolve via archetype metadata (match default_name)
    for arch, meta in ARCHETYPE_META.items():
        if meta.default_name.lower() == focus_l:
            # Check category first for recovery/mobility
            if meta.category in ("recovery", "mobility"):
                return "recovery"
            family = ARCHETYPE_TO_FOCUS_FAMILY.get(arch, "")
            if family in _WARMUP_REGION_LOWER:
                return "lower"
            if family in _WARMUP_REGION_PULL:
                return "pull"
            if family in _WARMUP_REGION_PUSH_UPPER:
                return "push_upper"
            if meta.category == "cond":
                return "general"
            return "general"

    # 2. Fallback for labels that don't match any archetype default_name
    if any(k in focus_l for k in ("recovery", "mobility", "stretch")):
        return "recovery"
    if any(k in focus_l for k in ("leg", "lower", "squat", "glute", "hinge")):
        return "lower"
    if any(k in focus_l for k in ("pull", "back", "row")):
        return "pull"
    if any(k in focus_l for k in ("push", "chest", "shoulder", "upper")):
        return "push_upper"
    return "general"


def _deterministic_warmup(focus: str, first: str | None, second: str | None,
                            exercise_count: int = 0) -> list[str]:
    """Vary 1-4 steps based on focus + session size + first lift type.
    Recovery/mobility days get a single prep line. Short sessions get
    a tighter warmup. Heavy compounds always get a ramp-up."""
    first_l = (first or "").lower()
    is_heavy_compound = any(k in first_l for k in (
        "squat", "deadlift", "bench", "overhead press", "ohp",
        "barbell press", "clean", "snatch", "hip thrust",
    ))
    ramp = (
        f"2-3 ramp-up sets of {first}" if (first and is_heavy_compound)
        else (f"1 light set of {first}" if first else "2 ramp-up sets at 50%")
    )

    region = _classify_warmup_region(focus)

    if region == "recovery":
        return ["Move slowly through the first round to warm up."]

    if region == "lower":
        pool = ["3 min easy bike or walk", "Hip circles + ankle rocks (10 each)", "Bodyweight squats × 10"]
    elif region == "pull":
        pool = ["3 min light cardio", "Band pull-aparts × 15", "Scap push-ups × 10"]
    elif region == "push_upper":
        pool = ["3 min light cardio", "Arm circles + band dislocates × 10", "Push-ups × 10"]
    else:
        pool = ["2 min light cardio", "Dynamic stretches for major joints"]

    if exercise_count <= 3:
        prep_count = 1
    elif exercise_count <= 5:
        prep_count = 2
    else:
        prep_count = len(pool)

    return pool[:prep_count] + [ramp]


@router.post("/warmup")
def generate_warmup(
    body: WarmupRequest,
    current_user: User = Depends(require_pro_feature("AI warmups")),
):
    """AI-generated warm-up tailored to today's workout + user injuries.
    Cheap call: ~300 input / ~200 output tokens on gpt-4o-mini.
    Falls back to a deterministic template on any failure."""
    first_ex = body.exercises[0].get("name") if body.exercises else None
    second_ex = body.exercises[1].get("name") if len(body.exercises) > 1 else None

    ex_count = len(body.exercises or [])
    api_key = get_openai_api_key()
    if not api_key:
        return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex, ex_count), "source": "fallback"}

    try:
        client = OpenAI(api_key=api_key)
        ex_lines = "\n".join(
            f"  - {e.get('name', '?')} ({e.get('equipment') or 'bodyweight'})"
            for e in body.exercises[:6]
        ) or "  (no exercises)"
        injuries_line = ", ".join(body.injuries) if body.injuries else "none"
        # Step count varies by session length so the warmup doesn't
        # always feel like the same template.
        if ex_count <= 3:
            target_steps = "2-3"
        elif ex_count <= 5:
            target_steps = "3"
        else:
            target_steps = "3-4"
        prompt = (
            f"Write a {target_steps}-step warm-up for today's workout. "
            "Each step must be SHORT — under 8 words, like a gym whiteboard. "
            "No paragraphs, no explanations.\n\n"
            f"Focus: {body.focus}\n"
            f"Total exercises today: {ex_count}\n"
            f"Injuries to avoid: {injuries_line}\n"
            f"First exercise: {first_ex or 'compound lift'}\n"
            f"Today's exercises:\n{ex_lines}\n\n"
            "Format: action + reps/duration. Examples:\n"
            '  "3 min easy bike"\n'
            '  "Hip circles × 10 each"\n'
            '  "Band pull-aparts × 15"\n'
            '  "2 light sets of Bench Press"\n\n'
            f'Return JSON: {{"steps": [...]}} with exactly {target_steps} items.'
        )
        messages = [
            {"role": "system", "content": "You are a strength coach writing a tailored warm-up. Be concise, specific, and injury-aware. Return only the required JSON."},
            {"role": "user", "content": prompt},
        ]
        kwargs = _build_chat_kwargs(
            model_chat(),
            messages,
            json_schema=_WARMUP_SCHEMA,
            max_tokens=500,
            timeout_secs=20,
            ai_route="/ai/warmup",
            ai_user_id=current_user.id,
            ai_budget_bucket="coach_chat",
        )
        response = _chat_create(client, **kwargs)
        data = _extract_json(response.choices[0].message.content or "")
        steps = data.get("steps") if isinstance(data, dict) else None
        if not isinstance(steps, list) or not steps:
            return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex, ex_count), "source": "fallback"}
        cleaned = [str(s).strip() for s in steps if str(s).strip()]
        return {"steps": cleaned[:6], "source": "ai"}
    except Exception as exc:
        print(f"[ai/warmup] failed (non-fatal): {exc}")
        return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex, ex_count), "source": "fallback"}


# ── Pre-set recommendation (deterministic) ──────────────────────────
# Shown in the active-workout card BEFORE the user logs a set, so the
# user can see recommended weight + reps + set intent (heavy/backoff/
# volume/technique) + a one-sentence rationale. Zero AI cost.
# Deprecated compatibility route. Canonical path:
# `POST /recommendations/pre-set`.
@router.post("/pre-set-recommendation")
def pre_set_recommendation(
    body: PreSetRecommendRequest,
    current_user: User = Depends(require_pro_feature("In-workout set review")),
    db: Session = Depends(get_session),
    background_tasks: BackgroundTasks = None,
):
    from app.services.workout.set_programming import (
        PlannedSet as PS,
        NextSetRecommendation,
        load_increment_for,
        parse_rep_range,
        recommend_next_set,
    )
    from app.services.workout.recommendation_schema import (
        enrich_to_set_recommendation,
    )

    # 1. Resolve the planned set we're about to do. Client plan snapshots are
    # treated as advisory execution context: stale/missing/malformed rows fall
    # back to a safe deterministic working set instead of crashing the workout.
    planned_set_number = _safe_positive_int(body.plannedSetNumber, 1)
    raw = _scheme_row_by_number(body.plannedSets, planned_set_number) or {}
    fallback_weight = _positive_float(body.weightLbs)
    if fallback_weight is not None and fallback_weight > 2000:
        fallback_weight = None
    row_target_weight = _positive_float(raw.get("targetWeightLbs") if "targetWeightLbs" in raw else raw.get("target_weight_lbs"))
    if row_target_weight is not None and row_target_weight > 2000:
        row_target_weight = None
    target_reps_hint = _target_reps_hint(raw, "8-12") or "8-12"
    set_type_hint = _set_programming_set_type(raw.get("setType") or raw.get("set_type"), target_reps_hint)
    planned = PS(
        set_number=planned_set_number,
        set_type=set_type_hint,
        target_reps=target_reps_hint,
        target_rir=float(max(0.0, min(5.0, _finite_float(raw.get("targetRir") if "targetRir" in raw else raw.get("target_rir")) or 2.0))),
        target_weight_lbs=row_target_weight or fallback_weight,
        progression_mode=_set_programming_progression_mode(
            raw.get("progressionMode") or raw.get("progression_mode"),
            set_type_hint,
        ),
    )

    # 2. Build a minimal exercise dict for the increment helper.
    exercise = _set_programming_exercise_metadata(
        db,
        body.exerciseName,
        body.exerciseSlug,
        body.equipment,
        body.primaryMuscle,
    )
    from app.services.workout.exercise_metadata import uses_numeric_load
    numeric_load = uses_numeric_load(exercise)
    equipment_label = _equipment_label_for_recommendation(body.equipment, exercise)
    equipment_settings = _equipment_settings_for_user(db, current_user)
    fallback_increment = load_increment_for(exercise)
    if fallback_increment <= 0:
        fallback_increment = 2.5 if "dumbbell" in (equipment_label or "").lower() else 5.0
    try:
        from app.services.workout.load_equipment import load_increment_lbs
        effective_increment_lbs = load_increment_lbs(
            equipment_label,
            equipment_settings,
            fallback=fallback_increment,
        )
    except Exception:
        effective_increment_lbs = fallback_increment

    prior = body.priorSetsThisSession or []
    last_session = body.lastSessionSets or []
    if not numeric_load:
        planned.target_weight_lbs = None
        last_session = []

    # DB-side fallback: the client's name-based `lastSessionSets` lookup
    # misses when the generated plan exercise name differs from the logged
    # history name (e.g. "Back Squat" vs "Barbell Back Squat"). Ask the DB
    # directly via slug; this is what the /recommend-weight endpoint does and
    # keeps the two endpoints consistent.
    if numeric_load and not last_session and db is not None:
        try:
            from app.services.workout.history import db_history_lookup
            slug = _resolve_exercise_slug(db, body.exerciseName, body.exerciseSlug)
            if slug:
                hist = db_history_lookup(current_user.id, db)(slug)
                if hist:
                    last_session = [
                        {
                            "reps": int(s.reps or 0),
                            "weightLbs": float(s.weight_lbs or 0.0),
                            # Forward RIR so the first-set-of-session
                            # decision below can route through the
                            # under-rep regression path instead of
                            # silently holding the same weight.
                            "rir": getattr(s, "rir", None),
                            "date": (
                                s.performed_on.isoformat()
                                if getattr(s, "performed_on", None) else None
                            ),
                        }
                        for s in hist
                        if (s.weight_lbs or 0) > 0
                    ]
        except Exception:
            logger.exception("[pre-set] DB history lookup failed (non-fatal)")

    is_first_session = not last_session
    is_first_set = len(prior) == 0

    # 3. Deterministic target weight + reps.
    #    - If there's a prior set this session → feed it into recommend_next_set
    #      (so Set 3 knows what happened on Set 2)
    #    - Else if last session data exists → use that as the anchor
    #    - Else → fall back to planner's target_weight_lbs
    data_source = "default"
    if prior:
        last = prior[-1]
        det = recommend_next_set(
            exercise=exercise,
            planned_set=planned,
            actual_reps=int(last.get("reps") or 0),
            actual_weight_lbs=float(last.get("weightLbs") or 0.0),
            actual_rir=last.get("rir"),
            rep_range=parse_rep_range(planned.target_reps),
        )
        data_source = "session_state"
    elif numeric_load and last_session:
        # Infer a plausible opening weight from the best comparable
        # last-session set. Exact recent history beats the plan snapshot:
        # PlanWeek targets can be several days old, while this is what the
        # user actually lifted last time.
        best = max(
            last_session,
            key=lambda s: float(s.get("weightLbs") or s.get("weight_lbs") or 0)
            * max(1, int(s.get("reps") or s.get("actual_reps") or 1)),
        )
        raw_weight = float(best.get("weightLbs") or best.get("weight_lbs") or 0)
        raw_reps = best.get("reps") or best.get("actual_reps")
        # Did the user consistently MISS the target rep range last time?
        # If the entire last session under-repped the bottom of the
        # prescribed range (e.g. target 8-10, every set hit 4-6), opening
        # at the same weight will reproduce the failure. Compute this
        # BEFORE the rep-aware rescale so the explanation can call out
        # the reason for the drop.
        target_lo: int | None = None
        try:
            from app.services.workout.set_programming import parse_rep_range as _parse_rr
            rr = _parse_rr(planned.target_reps)
            target_lo = rr[0] if rr else None
        except Exception:
            target_lo = None

        def _set_reps(s: dict) -> int:
            try:
                return int(s.get("reps") or s.get("actual_reps") or 0)
            except (TypeError, ValueError):
                return 0

        majority_missed = False
        if target_lo and target_lo > 0:
            graded_sets = [s for s in last_session if _set_reps(s) > 0]
            if graded_sets:
                missed = sum(1 for s in graded_sets if _set_reps(s) < target_lo)
                # "Majority" = strictly more than half of recorded sets
                # were below the lo end of the rep range.
                majority_missed = missed * 2 > len(graded_sets)

        weight = _rep_adjust_legacy_anchor(
            raw_weight=raw_weight,
            raw_reps=raw_reps,
            target_reps=planned.target_reps,
        ) or raw_weight
        weight, recency_adj = _apply_reacclimation_if_stale(
            weight,
            _history_row_performed_on(best),
            increment_lbs=effective_increment_lbs,
        )
        # Build the action + explanation. The historic code path always
        # said "hold_load" even when the rescaled weight was meaningfully
        # lower — the frontend treated that as "no change" and showed the
        # original weight, so a user who under-repped 4 reps under target
        # saw the same recommendation week after week. Now we surface a
        # real `reduce_load` action when either:
        #   (a) the rescaled weight came in lower than what she lifted, or
        #   (b) she missed the rep target on a majority of last session's
        #       sets (most direct signal — covers the case where the
        #       Epley rescale happens to round to the same plate)
        weight_dropped = (
            raw_weight > 0
            and weight > 0
            and weight < raw_weight - 0.5
        )
        action: str = "hold_load"
        if majority_missed or weight_dropped:
            action = "reduce_load"
            # Clamp the recommendation when majority_missed but the rescale
            # rounded equal — force at least one increment down so the
            # next set is actually different.
            if majority_missed and not weight_dropped and raw_weight > 0:
                step = effective_increment_lbs if effective_increment_lbs and effective_increment_lbs > 0 else 5.0
                from app.services.workout.set_programming import round_to_increment
                weight = max(step, round_to_increment(raw_weight - step, step))
                weight_dropped = True

        if recency_adj is not None:
            explanation = (
                f"Opening at {int(weight)} lb — {recency_adj.reason} for "
                f"{body.exerciseName}."
            )
        elif action == "reduce_load":
            # Tell the user WHY we dropped — vague "use lighter weight"
            # messages train users to ignore the suggestion.
            range_label = planned.target_reps or "the target range"
            explanation = (
                f"Opening at {int(weight)} lb — last session you missed the "
                f"{range_label}-rep target on most sets, so we're dropping "
                f"the working weight to get clean reps before going heavy again."
            )
        else:
            explanation = (
                f"Opening at {int(weight)} lb — same as your best working set last "
                f"{body.exerciseName} session."
            ) if weight > 0 else "Opening at the planned weight."
        det = NextSetRecommendation(
            next_set_weight_lbs=weight if weight > 0 else planned.target_weight_lbs,
            next_set_rep_target=planned.target_reps,
            action=action,
            explanation=explanation,
        )
        data_source = "exact_exercise_history"
    elif planned.target_weight_lbs and planned.target_weight_lbs > 0:
        det = NextSetRecommendation(
            next_set_weight_lbs=planned.target_weight_lbs,
            next_set_rep_target=planned.target_reps,
            action="hold_load",
            explanation=(
                f"Opening at {int(planned.target_weight_lbs)} lb — this is the "
                "target your plan set for today."
            ),
        )
        data_source = "plan_snapshot"
    else:
        # First-ever session on this exercise — use the planner's
        # deterministic target/default and calibrate from the user's first set.
        det = NextSetRecommendation(
            next_set_weight_lbs=planned.target_weight_lbs,
            next_set_rep_target=planned.target_reps,
            action="hold_load",
            explanation=(
                f"First time on {body.exerciseName} — starting at "
                f"{int(planned.target_weight_lbs or 0) or '?'} lb to calibrate. "
                "Tell me how it feels after the set."
            ),
        )

    if numeric_load and det.next_set_weight_lbs is not None and det.next_set_weight_lbs > 0:
        original_weight = float(det.next_set_weight_lbs)
        snapped_weight = _snap_recommendation_load(
            original_weight,
            equipment_label=equipment_label,
            equipment_settings=equipment_settings,
            fallback_increment=effective_increment_lbs,
        )
        if snapped_weight is not None:
            det.next_set_weight_lbs = float(snapped_weight)
            if abs(float(snapped_weight) - original_weight) > 0.01:
                det.explanation = _loadability_adjusted_text(original_weight, float(snapped_weight))

    rec = enrich_to_set_recommendation(
        det=det,
        planned=planned,
        actual_reps=None,
        actual_weight=None,
        feel=body.feelFromLastSet,
        is_first_session=is_first_session,
        is_first_set=is_first_set,
        rep_range=parse_rep_range(planned.target_reps),
        source="deterministic",
        data_source=(
            "session_state" if prior
            else data_source
        ),
    )
    out = rec.to_dict()
    out["aiSafety"] = prepare_ai_safety_review(
        _ai_safety_payload_for_pre_set(
            body=body,
            exercise_meta=exercise,
            numeric_load=numeric_load,
            recommended_weight_lbs=rec.recommended_weight_lbs,
            recommended_reps=rec.recommended_reps,
            data_source=rec.data_source,
            confidence=rec.confidence,
            action=rec.change_direction,
            planned_weight_lbs=row_target_weight or fallback_weight,
            last_session_sets=last_session,
            prior_sets=prior,
            reason_tags=rec.reason_tags,
        ),
        user_id=getattr(current_user, "id", None),
        background_tasks=background_tasks,
    )
    return out


# ── Custom-food macro + micro validation ────────────────────────────
# Called on-demand from the client when a custom food is tapped or
# when the library runs a batch sanity-check. Returns corrected
# macros/micros + a verification verdict:
#   ok                 — values match USDA within tolerance; no changes
#   corrected          — AI found a meaningful error and returned fixes
#   insufficient_data  — AI couldn't find a USDA reference (e.g. a
#                        brand-specific packaged food it doesn't know)
#
# The client stores the verdict as `verification_status` on the custom
# food row so the UI can show a badge and skip re-validation next time.
_FOOD_VALIDATION_SCHEMA = {
    "name": "food_macro_validation",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["verdict", "notes"],
        "properties": {
            "verdict": {"type": "string", "enum": ["ok", "corrected", "insufficient_data"]},
            "notes": {"type": "string", "maxLength": 200},
            "corrected": {
                "type": ["object", "null"],
                "properties": {
                    "calories": {"type": ["number", "null"]},
                    "protein":  {"type": ["number", "null"]},
                    "carbs":    {"type": ["number", "null"]},
                    "fat":      {"type": ["number", "null"]},
                    "micros":   {"type": ["object", "null"]},
                },
            },
        },
    },
}


@router.post("/validate-food-macros")
def validate_food_macros(
    body: ValidateFoodMacrosRequest,
    current_user: User = Depends(require_pro_feature("Food macro validation")),
):
    """Validate one custom food's macros + micros against USDA reference.

    Cheap call (~300 input + ~300 output tokens on gpt-4o-mini ≈ $0.0002).
    The client is expected to call this lazily (e.g. first time the food
    is opened in detail view) and cache the verdict per food."""
    api_key = get_openai_api_key()
    if not api_key:
        return {
            "verdict": "insufficient_data",
            "notes": "AI unavailable (no API key configured).",
            "corrected": None,
        }

    try:
        client = OpenAI(api_key=api_key)
        current_payload = {
            "name": body.name,
            "serving": body.servingLabel,
            "calories": body.calories,
            "protein": body.protein,
            "carbs": body.carbs,
            "fat": body.fat,
            "micronutrients": body.micronutrients or {},
        }
        prompt = (
            "You are a USDA nutrition database. Given a food + serving + claimed "
            "macros + optional micronutrients, decide whether the claimed values "
            "match reference data within tolerance.\n\n"
            "Rules:\n"
            "1. Tolerance: ±15% on calories and macros is ok. Outside that → 'corrected'.\n"
            "2. If micronutrients are missing or ALL zero, return 'corrected' with a\n"
            "   full USDA-derived micronutrient panel for this serving.\n"
            "3. If the food is too generic or brand-specific to verify (e.g. 'my\n"
            "   homemade bowl', 'grandma's stew'), return 'insufficient_data'.\n"
            "4. Use snake_case micronutrient keys: fiber, sugar, sodium, cholesterol,\n"
            "   saturated_fat, monounsaturated_fat, polyunsaturated_fat, omega_3,\n"
            "   omega_6, potassium, calcium, iron, magnesium, vitamin_c, vitamin_d,\n"
            "   vitamin_b12. Units: g for fats/fiber/sugar, mg for sodium/cholesterol/\n"
            "   omega_*/minerals/vitamin_c, mcg for vitamin_d and vitamin_b12.\n\n"
            f"Food to validate:\n{json.dumps(current_payload, indent=2)}\n\n"
            "Return JSON: {\"verdict\": \"ok\"|\"corrected\"|\"insufficient_data\", "
            "\"notes\": \"<one sentence explanation>\", "
            "\"corrected\": null OR {calories, protein, carbs, fat, micros}}"
        )
        kwargs = _build_chat_kwargs(
            model_chat(),
            [
                {"role": "system", "content": "You are a precise USDA nutrition reference. Return only the required JSON."},
                {"role": "user", "content": prompt},
            ],
            json_schema=_FOOD_VALIDATION_SCHEMA,
            max_tokens=500,
            timeout_secs=20,
            ai_route="/ai/validate-food-macros",
            ai_user_id=current_user.id,
            ai_budget_bucket="food_enrichment",
        )
        response = _chat_create(client, **kwargs)
        data = _extract_json(response.choices[0].message.content or "")
        if not isinstance(data, dict):
            return {"verdict": "insufficient_data", "notes": "invalid response shape", "corrected": None}
        return {
            "verdict": data.get("verdict") or "insufficient_data",
            "notes": str(data.get("notes") or "")[:200],
            "corrected": data.get("corrected"),
        }
    except Exception as exc:
        print(f"[validate_food_macros] failed: {exc}")
        return {"verdict": "insufficient_data", "notes": f"error: {exc}", "corrected": None}
